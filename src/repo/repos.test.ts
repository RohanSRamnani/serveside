import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { withLocation, scopedPool } from './scoped'
import { ordersRepo } from './orders-repo'
import { menuRepo } from './menu-repo'
import { menus, menuItems } from '@/db/schema'
import { seedLocationWithMenu, seedPaidOrder } from '@/test/seed'

describe('withLocation', () => {
  it('refuses anything that is not a location id, before it reaches SQL', async () => {
    // The policies cast the GUC to uuid. Without this guard the failure would be a
    // 22P02 from whichever query ran first, pointing at the wrong thing entirely.
    await expect(withLocation('not-a-uuid', async () => 1)).rejects.toThrow(/not a location id/)
  })

  it('does not leak the scope into the next transaction on the same pooled backend', async () => {
    // SET LOCAL, not SET — and this is the test that can tell the difference. Both
    // transactions below run on the **same** websocket Pool. Reading through `db()`
    // would prove nothing at all: neon-http is a different connection that could
    // never have seen the GUC in the first place.
    const loc = await seedLocationWithMenu()
    const PROBE = `select pg_backend_pid() as pid,
                          current_setting('app.location_id', true) as guc,
                          (select count(*) from menus) as visible`

    const scoped = (await withLocation(loc.id, (tx) => tx.execute(sql.raw(PROBE)))).rows[0] as Probe
    expect(scoped.guc).toBe(loc.id)
    expect(Number(scoped.visible)).toBeGreaterThan(0)

    // Neon's pooled endpoint is PgBouncer in transaction mode, so the backend behind
    // the socket can change between transactions — which is exactly the hazard worth
    // testing, not a reason to skip it. Probe unscoped until we land back on the very
    // backend that was scoped to `loc`, and assert on that one.
    let reused: Probe | undefined
    for (let attempt = 0; attempt < 20 && !reused; attempt++) {
      const row = (await scopedPool().query(PROBE)).rows[0] as Probe
      // Every unscoped probe must be blind, whichever backend answered it.
      expect(row.guc ?? '').toBe('')
      expect(Number(row.visible)).toBe(0)
      if (row.pid === scoped.pid) reused = row
    }
    expect(reused, 'never landed back on the scoped backend, so reuse went untested').toBeDefined()
  })
})

type Probe = { pid: number; guc: string | null; visible: string }

describe('ordersRepo', () => {
  it('writes an order and its lines in one transaction, and reads them back', async () => {
    const loc = await seedLocationWithMenu()
    const { order, item } = await seedPaidOrder(loc.id)

    const read = await withLocation(loc.id, async (tx) => {
      const repo = ordersRepo(tx)
      return { order: await repo.getById(order.id), items: await repo.itemsFor(order.id) }
    })
    expect(read.order?.totalCents).toBe(4524)
    expect(read.items).toHaveLength(1)
    expect(read.items[0].id).toBe(item.id)
    expect(read.items[0].nameSnapshot).toBe('Butter Chicken')
  })

  it('reads another location\'s order id as not-found, not as forbidden', async () => {
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()
    const { order } = await seedPaidOrder(locA.id)
    const found = await withLocation(locB.id, (tx) => ordersRepo(tx).getById(order.id))
    expect(found).toBeUndefined()
  })

  it('lists only this location\'s orders since a time, oldest first', async () => {
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()
    const first = await seedPaidOrder(locA.id)
    const second = await seedPaidOrder(locA.id)
    await seedPaidOrder(locB.id) // must not appear, and nothing here filters it out

    // Both bounds come off `createdAt`, which Postgres wrote. Taking them from the
    // test process's own clock would make this flake on any skew against Neon.
    const listed = await withLocation(locA.id, (tx) =>
      ordersRepo(tx).listSince(first.order.createdAt.toISOString()))
    expect(listed.map((o) => o.id)).toEqual([first.order.id, second.order.id])

    // The cut-off is real, not decorative: one millisecond past the last order.
    const after = new Date(second.order.createdAt.getTime() + 1).toISOString()
    expect(await withLocation(locA.id, (tx) => ordersRepo(tx).listSince(after))).toHaveLength(0)
  })
})

describe('menuRepo', () => {
  it('returns the active menu, down to the modifier options, without being told the location', async () => {
    // The repo takes no locationId at all: the transaction carries the scope. That
    // is the whole ergonomic point of doing this in the database.
    const loc = await seedLocationWithMenu()
    const menu = await withLocation(loc.id, (tx) => menuRepo(tx).activeMenu())
    expect(menu?.id).toBe(loc.menu.id)
    expect(menu?.categories[0].items.map((i) => i.name)).toEqual(['Butter Chicken', 'Lamb Rogan Josh'])
    expect(menu?.categories[0].items[0].modifierGroupLinks[0].group.options.map((o) => o.name))
      .toEqual(['Hot', 'Mild'])
  })

  it('has no active menu for a location that has none of its own', async () => {
    const locA = await seedLocationWithMenu()
    const bare = await seedLocationWithMenu()
    // Retire the bare location's menu; locA's stays active and must not show up.
    await withLocation(bare.id, (tx) =>
      tx.update(menus).set({ isActive: false }).where(eq(menus.id, bare.menu.id)))
    expect(await withLocation(bare.id, (tx) => menuRepo(tx).activeMenu())).toBeUndefined()
    expect(await withLocation(locA.id, (tx) => menuRepo(tx).activeMenu())).toBeDefined()
  })

  it('refuses to guess between two active menus', async () => {
    const loc = await seedLocationWithMenu()
    await withLocation(loc.id, (tx) => tx.insert(menus).values({ locationId: loc.id, name: 'Late Night' }))
    await expect(withLocation(loc.id, (tx) => menuRepo(tx).activeMenu()))
      .rejects.toThrow(/more than one active menu/i)
  })

  it('86s an item until a time', async () => {
    const loc = await seedLocationWithMenu()
    const until = new Date(Date.now() + 86_400_000)
    const updated = await withLocation(loc.id, (tx) => menuRepo(tx).set86(loc.items[0].id, until))
    expect(updated?.is86d).toBe(true)
    expect(updated?.unsnoozeAt?.getTime()).toBe(until.getTime())
  })

  it('cannot 86 another location\'s item, and says so by updating nothing', async () => {
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()
    const updated = await withLocation(locB.id, (tx) => menuRepo(tx).set86(locA.items[0].id, null))
    expect(updated).toBeUndefined()

    // And the dish really is still on sale at the restaurant that owns it. This is
    // the silent half of RLS: no error was raised, so nothing may read "no error"
    // as "it worked".
    const [item] = await withLocation(locA.id, (tx) =>
      tx.select().from(menuItems).where(eq(menuItems.id, locA.items[0].id)))
    expect(item.is86d).toBe(false)
  })
})
