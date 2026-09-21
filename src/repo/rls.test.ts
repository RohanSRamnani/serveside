import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withLocation } from './scoped'
import { seedLocationWithMenu, seedPaidOrder } from '@/test/seed'
import { buildMenuSnapshot } from '@/domain/snapshot'
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
    // assertion below vacuous. Two things are being checked at once: the facts, and
    // that `withLocation` itself refuses to open a scope without checking them — its
    // boot assertion runs on the first call in the process, so reaching the callback
    // at all is the guard passing.
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

  it('leaves no table in public unpoliced without someone deciding to', async () => {
    // The guard against the next table. A Task 9 migration that adds a
    // location-scoped table and forgets its policy fails here, by name, rather than
    // leaking quietly for a release. Adding a table to one of these two lists is the
    // conscious decision; there is no way to add one to neither.
    const rows = await withLocation('00000000-0000-0000-0000-000000000000', (tx) =>
      tx.execute(sql`
        select c.relname as table, c.relrowsecurity as rls
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname`))
    const byName = (rows.rows as { table: string; rls: boolean }[])

    expect(byName.filter((r) => r.rls).map((r) => r.table)).toEqual([
      'availability_windows', 'business_hours', 'holiday_closures', 'item_modifier_groups',
      'menu_categories', 'menu_items', 'menu_snapshots', 'menus', 'modifier_groups',
      'modifier_options', 'order_events', 'order_item_modifiers', 'order_items',
      'order_pauses', 'orders', 'print_jobs', 'printers',
    ])
    // Exempt on purpose, and only these. Three are the tenancy root, which has nothing
    // to scope to until a location exists (0008). The fourth, `webhook_events`, is the
    // deliberate Task 9 addition: a webhook is authenticated by its signature and
    // arrives before anything knows whose it is — the location is inside the payload,
    // so there is no scope to open at the moment the row must be written, and opening
    // one from the unverified body would be scoping to whatever the caller claimed.
    // The handler opens `withLocation` for the order write. Documented in CLAUDE.md,
    // in 0008 and in 0011.
    expect(byName.filter((r) => !r.rls).map((r) => r.table)).toEqual([
      'locations', 'memberships', 'organizations', 'webhook_events',
    ])
  })

  it('has exactly one way around row security, and it is the printer lookup', async () => {
    // A SECURITY DEFINER function runs as its owner, and this database's owner owns
    // every table — so one of these is a hole straight through everything above.
    // There is exactly one, `printer_lookup` (drizzle/0012), because a CloudPRNT
    // printer can only present the MAC burnt into it and the location that would
    // scope the lookup is the thing being looked up. The next one must be argued for
    // here, by name, rather than appearing quietly in a migration.
    const defs = await db().execute(sql`
      select p.proname as name, coalesce(array_to_string(p.proconfig, ' '), '') as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
      order by p.proname`)
    const fns = defs.rows as { name: string; cfg: string }[]
    expect(fns.map((f) => f.name)).toEqual(['printer_lookup'])
    // And its search_path is pinned, or a role able to create objects could shadow
    // `printers` with its own table and have the owner read that instead.
    expect(fns[0].cfg).toMatch(/search_path=/)
  })

  it('grants app_user nothing on tables that do not exist yet', async () => {
    // Backs the REVOKE in 0008: a table added later is unreadable until its migration
    // grants it, which is the moment someone has to think about its policy. Also
    // verifies the live branch really is in the state the committed migration
    // describes, independently of how many times it was replayed.
    const acl = await withLocation('00000000-0000-0000-0000-000000000000', (tx) =>
      tx.execute(sql`
        select coalesce(string_agg(a::text, ' '), '') as acl
        from pg_default_acl d, unnest(d.defaclacl) a
        where d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r'`))
    expect((acl.rows[0] as { acl: string }).acl).not.toMatch(/app_user/)
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
    // Build one, or the `menu_snapshots` row below asserts that an empty table is
    // empty and the one table holding a whole menu as JSON goes untested.
    const snapshot = await buildMenuSnapshot(locA.id)

    const seen = await withLocation(locB.id, async (tx) => ({
      menus: (await tx.execute(sql`select id from menus where id = ${locA.menu.id}`)).rows,
      categories: (await tx.execute(sql`select id from menu_categories where id = ${locA.category.id}`)).rows,
      items: (await tx.execute(sql`select id from menu_items where id = ${locA.items[0].id}`)).rows,
      groups: (await tx.execute(sql`select id from modifier_groups where id = ${locA.modifierGroup.id}`)).rows,
      options: (await tx.execute(sql`select id from modifier_options where id = ${locA.modifierOptions[0].id}`)).rows,
      links: (await tx.execute(sql`select * from item_modifier_groups where item_id = ${locA.items[0].id}`)).rows,
      snapshots: (await tx.execute(sql`select id from menu_snapshots where id = ${snapshot.id}`)).rows,
    }))
    for (const [table, rows] of Object.entries(seen)) {
      expect(rows, `${table} leaked across locations`).toHaveLength(0)
    }
    // The control: every id above is real and readable by the location that owns it,
    // so "zero rows" above means hidden, not mistyped.
    const own = await withLocation(locA.id, async (tx) => ({
      menus: (await tx.execute(sql`select id from menus where id = ${locA.menu.id}`)).rows,
      snapshots: (await tx.execute(sql`select id from menu_snapshots where id = ${snapshot.id}`)).rows,
      links: (await tx.execute(sql`select * from item_modifier_groups where item_id = ${locA.items[0].id}`)).rows,
    }))
    for (const [table, rows] of Object.entries(own)) {
      expect(rows, `${table} is not readable by its own location`).toHaveLength(1)
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

  it('refuses a child row hung off another location\'s parent', async () => {
    // order_items has no location_id to get wrong, so WITH CHECK is the only thing
    // standing between locB and a line item — and a charge — on locA's order. The
    // positive control runs first so a blanket "inserts are broken" cannot pass this.
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()
    const { order } = await seedPaidOrder(locA.id)

    const added = await withLocation(locA.id, (tx) => tx.execute(sql`
      insert into order_items (order_id, menu_item_id, name_snapshot, qty, unit_price_cents, line_total_cents)
      values (${order.id}, ${locA.items[1].id}, 'Lamb Rogan Josh', 1, 2100, 2100) returning id`))
    expect(added.rows).toHaveLength(1)

    const text = await rejectionText(() => withLocation(locB.id, (tx) => tx.execute(sql`
      insert into order_items (order_id, menu_item_id, name_snapshot, qty, unit_price_cents, line_total_cents)
      values (${order.id}, ${locB.items[0].id}, 'Trojan', 1, 1, 1)`)))
    expect(text).toMatch(/row-level security/i)

    // Same story one level down, and one level along: an event on someone else's order.
    const events = await rejectionText(() => withLocation(locB.id, (tx) => tx.execute(sql`
      insert into order_events (order_id, type, actor) values (${order.id}, 'status_changed', 'trojan')`)))
    expect(events).toMatch(/row-level security/i)
  })

  it('refuses a category gated by another location\'s availability window', async () => {
    // RI checks bypass row security, so the FK would have allowed this and no WHERE
    // clause would have caught it — the category would then be on and off the menu
    // according to a schedule its owner cannot see, let alone edit.
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()
    const [windowA] = (await withLocation(locA.id, (tx) => tx.execute(sql`
      insert into availability_windows (location_id, dow, start_time, end_time)
      values (${locA.id}, 5, '17:00:00', '22:00:00') returning id`))).rows as { id: string }[]

    const text = await rejectionText(() => withLocation(locB.id, (tx) => tx.execute(sql`
      insert into menu_categories (menu_id, name, availability_window_id)
      values (${locB.menu.id}, 'Borrowed Hours', ${windowA.id})`)))
    expect(text).toMatch(/row-level security/i)

    // Its own window is fine, and so is no window at all — the common case, which a
    // careless `IS NULL` omission in the policy would have broken for everyone.
    const ok = await withLocation(locB.id, async (tx) => {
      const [windowB] = (await tx.execute(sql`
        insert into availability_windows (location_id, dow, start_time, end_time)
        values (${locB.id}, 5, '17:00:00', '22:00:00') returning id`)).rows as { id: string }[]
      return tx.execute(sql`
        insert into menu_categories (menu_id, name, availability_window_id) values
          (${locB.menu.id}, 'Own Hours', ${windowB.id}),
          (${locB.menu.id}, 'All Day', null)
        returning id`)
    })
    expect(ok.rows).toHaveLength(2)
  })

  it('cannot pause another restaurant, or unpick their opening hours', async () => {
    // Not a privacy question — a revenue one. `app_user` holds INSERT and DELETE on
    // these tables, so without a policy one restaurant could stop another taking
    // orders, or delete the hours that say they are open.
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()
    await withLocation(locA.id, (tx) => tx.execute(sql`
      insert into business_hours (location_id, dow, open_time, close_time)
      values (${locA.id}, 2, '17:00:00', '22:00:00')`))

    const paused = await rejectionText(() => withLocation(locB.id, (tx) => tx.execute(sql`
      insert into order_pauses (location_id, until, reason)
      values (${locA.id}, now() + interval '8 hours', 'sabotage')`)))
    expect(paused).toMatch(/row-level security/i)

    const deleted = await withLocation(locB.id, (tx) =>
      tx.execute(sql`delete from business_hours where location_id = ${locA.id} returning id`))
    expect(deleted.rows).toHaveLength(0)

    const hidden = await withLocation(locB.id, (tx) => tx.execute(sql`
      select (select count(*) from business_hours) as hours,
             (select count(*) from holiday_closures) as closures,
             (select count(*) from order_pauses) as pauses`))
    expect(hidden.rows[0]).toMatchObject({ hours: '0', closures: '0', pauses: '0' })

    // And locA still has the row it posted, so "zero" above means hidden, not deleted.
    const own = await withLocation(locA.id, (tx) => tx.execute(sql`select id from business_hours`))
    expect(own.rows).toHaveLength(1)
  })

  it('cannot read, steal or misdirect another restaurant\'s printer and print jobs', async () => {
    // A print job is a physical ticket with a customer's name and phone number on it.
    // Two separate leaks live here: reading another location's queue, and — the one a
    // location_id-only policy would miss — writing a job that names *this* location
    // while pointing at *that* location's order, which prints their ticket on our
    // printer. RI checks bypass row security, so the FK would have allowed it.
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()
    const { order } = await seedPaidOrder(locA.id)

    const own = await withLocation(locA.id, (tx) => tx.execute(sql`
      insert into print_jobs (location_id, order_id, payload) values
        (${locA.id}, ${order.id}, '*** K7M2 ***') returning id`))
    expect(own.rows).toHaveLength(1)
    await withLocation(locA.id, (tx) => tx.execute(sql`
      insert into printers (location_id, provider, serial)
      values (${locA.id}, 'star_cloudprnt', ${`00:11:62:${locA.id.slice(0, 8)}`})`))

    // Deliberately unscoped SQL, from the wrong tenant.
    const jobs = await withLocation(locB.id, (tx) => tx.execute(sql`select id from print_jobs`))
    expect(jobs.rows).toHaveLength(0)
    const seen = await withLocation(locB.id, (tx) => tx.execute(sql`select id from printers`))
    expect(seen.rows).toHaveLength(0)

    const stolen = await rejectionText(() => withLocation(locB.id, (tx) => tx.execute(sql`
      insert into print_jobs (location_id, order_id, payload)
      values (${locB.id}, ${order.id}, 'someone else''s dinner')`)))
    expect(stolen).toMatch(/row-level security/i)

    // And the plain cross-tenant write, which the direct location_id predicate refuses.
    const planted = await rejectionText(() => withLocation(locB.id, (tx) => tx.execute(sql`
      insert into printers (location_id, provider, serial)
      values (${locA.id}, 'star_cloudprnt', ${`ff:ff:ff:${locB.id.slice(0, 8)}`})`)))
    expect(planted).toMatch(/row-level security/i)
  })

  it('leaves webhook_events readable unscoped, on purpose', async () => {
    // The one exemption outside the tenancy root, and it has to be asserted rather
    // than assumed: a webhook is authenticated by its signature and arrives before
    // anything knows whose it is — the location is inside the payload. If this ever
    // starts failing because someone policied the table, the idempotency insert stops
    // working and Stripe's double deliveries start flipping orders twice.
    const externalId = `evt_rls_probe_${Date.now()}`
    await db().execute(sql`
      insert into webhook_events (provider, external_id, payload)
      values ('stripe', ${externalId}, '{}'::jsonb)`)
    const unscoped = await db().execute(sql`
      select id from webhook_events where external_id = ${externalId}`)
    expect(unscoped.rows).toHaveLength(1)
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
