import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withLocation } from './scoped'
import { seedLocationWithMenu, seedPaidOrder } from '@/test/seed'
import { rejectionText } from '@/test/errors'

/**
 * The point of Task 7, and the test that must never be deleted or weakened.
 *
 * Every other test in this suite asks whether the application code filters
 * correctly. These ask what happens when it does not: each one issues SQL with
 * **no WHERE clause at all** and expects the database to hand back nothing.
 *
 * If any of these ever go green by accident — because the test connection was
 * switched back to the table owner, because a policy was dropped in a migration,
 * because a new table landed without one — the belt is gone and only the braces
 * are left. `select current_user` below is part of the test for that reason: the
 * suite must not be able to pass by being privileged.
 */
describe('RLS tenancy', () => {
  it('does not connect as a role that can bypass RLS', async () => {
    // A superuser, a BYPASSRLS role, or the owner of these tables would make every
    // assertion below vacuous. Fail loudly here rather than silently there.
    const who = await withLocation('00000000-0000-0000-0000-000000000000', (tx) =>
      tx.execute(sql`
        select current_user as who,
               (select rolsuper from pg_roles where rolname = current_user) as is_super,
               (select rolbypassrls from pg_roles where rolname = current_user) as bypasses_rls,
               (select count(*) from pg_tables where schemaname = 'public' and tableowner = current_user) as owns
      `))
    const row = who.rows[0] as { who: string; is_super: boolean; bypasses_rls: boolean; owns: string }
    expect(row.is_super).toBe(false)
    expect(row.bypasses_rls).toBe(false)
    expect(Number(row.owns)).toBe(0)
  })

  it("a location cannot read another location's orders even with a raw unfiltered query", async () => {
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()
    const { order } = await seedPaidOrder(locA.id)

    const visible = await withLocation(locB.id, (tx) =>
      // Deliberately unscoped SQL — the missing WHERE clause this task exists for.
      tx.execute(sql`select id from orders`))
    expect(visible.rows).toHaveLength(0)

    // And the row really is there for the location that owns it.
    const own = await withLocation(locA.id, (tx) => tx.execute(sql`select id from orders`))
    expect(own.rows.map((r) => (r as { id: string }).id)).toContain(order.id)
  })

  it("a location cannot read another location's order lines — a child table polices via its parent", async () => {
    // order_items carries no location_id of its own; its policy walks up to orders.
    // This is the leak that a location_id-only sweep would have missed.
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()
    const { item } = await seedPaidOrder(locA.id)

    const items = await withLocation(locB.id, (tx) => tx.execute(sql`select id from order_items`))
    expect(items.rows).toHaveLength(0)

    const mods = await withLocation(locB.id, (tx) => tx.execute(sql`select * from order_item_modifiers`))
    expect(mods.rows).toHaveLength(0)

    const events = await withLocation(locB.id, (tx) => tx.execute(sql`select id from order_events`))
    expect(events.rows).toHaveLength(0)

    const own = await withLocation(locA.id, (tx) => tx.execute(sql`select id from order_items`))
    expect(own.rows.map((r) => (r as { id: string }).id)).toContain(item.id)
  })

  it("a location cannot read another location's menu, down the whole chain", async () => {
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()

    const seen = await withLocation(locB.id, async (tx) => ({
      menus: (await tx.execute(sql`select id from menus where id = ${locA.menu.id}`)).rows,
      categories: (await tx.execute(sql`select id from menu_categories where id = ${locA.category.id}`)).rows,
      items: (await tx.execute(sql`select id from menu_items where id = ${locA.items[0].id}`)).rows,
      groups: (await tx.execute(sql`select id from modifier_groups where id = ${locA.modifierGroup.id}`)).rows,
      options: (await tx.execute(sql`select id from modifier_options where id = ${locA.modifierOptions[0].id}`)).rows,
      links: (await tx.execute(sql`select * from item_modifier_groups where item_id = ${locA.items[0].id}`)).rows,
      snapshots: (await tx.execute(sql`select id from menu_snapshots`)).rows,
    }))
    for (const [table, rows] of Object.entries(seen)) {
      expect(rows, `${table} leaked across locations`).toHaveLength(0)
    }
  })

  it('cannot write a row into another location, however hard it tries', async () => {
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()

    // WITH CHECK: the insert names locA while the session is scoped to locB.
    const text = await rejectionText(() => withLocation(locB.id, (tx) =>
      tx.execute(sql`insert into menus (location_id, name, is_active) values (${locA.id}, 'Trojan', true)`)))
    expect(text).toMatch(/row-level security/i)

    // UPDATE and DELETE are filtered, not refused: the row is simply not there to
    // touch. Silent no-ops, which is why nothing may infer success from "no error".
    const updated = await withLocation(locB.id, (tx) =>
      tx.execute(sql`update menus set name = 'Renamed' where id = ${locA.menu.id} returning id`))
    expect(updated.rows).toHaveLength(0)

    const deleted = await withLocation(locB.id, (tx) =>
      tx.execute(sql`delete from menus where id = ${locA.menu.id} returning id`))
    expect(deleted.rows).toHaveLength(0)

    const survived = await withLocation(locA.id, (tx) =>
      tx.execute(sql`select name from menus where id = ${locA.menu.id}`))
    expect((survived.rows[0] as { name: string }).name).toBe('Dinner')
  })

  it('sees nothing at all when no location has been set', async () => {
    // Belt-and-braces for the braces: a connection that forgets to scope itself is
    // not a connection that sees everything, it is one that sees nothing.
    const locA = await seedLocationWithMenu()
    await seedPaidOrder(locA.id)
    const visible = await db().execute(sql`select id from orders`)
    expect(visible.rows).toHaveLength(0)
  })

  it('refuses an order pinned to another location\'s menu snapshot', async () => {
    // The composite FK (location_id, menu_snapshot_id) → menu_snapshots(location_id, id).
    // Without it, RLS would happily let locB write an order whose price evidence is
    // locA's menu — legal inside its own tenant, and nonsense.
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()
    const { snapshot } = await seedPaidOrder(locA.id)

    const text = await rejectionText(() => withLocation(locB.id, (tx) =>
      tx.execute(sql`
        insert into orders (
          location_id, short_code, channel, fulfillment, status, payment_status,
          contact_name, contact_phone, subtotal_cents, tax_cents, total_cents, menu_snapshot_id
        ) values (
          ${locB.id}, 'X1Y2', 'web', 'pickup', 'NEW', 'PAID',
          'Trojan', '+15550000000', 100, 9, 109, ${snapshot.id}
        )`)))
    expect(text).toMatch(/orders_snapshot_location_fk|foreign key/i)
  })
})
