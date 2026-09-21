import { and, asc, eq, sql } from 'drizzle-orm'
import {
  menus, menuCategories, menuItems, itemModifierGroups, modifierOptions, menuSnapshots,
} from '@/db/schema'
import type { MenuSnapshotPayload, SnapshotModifierGroup } from '@/db/schema'
import { withLocation, type ScopedTx } from '@/repo/scoped'

/** Rounds of the version race to lose before giving up. Contention is low. */
const MAX_VERSION_ATTEMPTS = 8

/**
 * Pins the location's active menu — prices and 86 flags included — into an
 * immutable `menu_snapshots` row, versioned per location from 1 up.
 *
 * Throws if the location has no active menu, or more than one: a snapshot that
 * silently omits half the menu is worse than a loud failure, because orders and
 * voice calls quote from this payload and disputes are settled against it.
 *
 * Every table it touches is under RLS, so it runs scoped. Pass a `tx` to build
 * inside a caller's transaction — that is how `createOrder` pins a snapshot and
 * writes the order it belongs to atomically. Without one it opens its own scope,
 * so the original one-argument call still works.
 */
export async function buildMenuSnapshot(
  locationId: string,
  tx?: ScopedTx,
): Promise<{ id: string; version: number }> {
  if (!tx) return withLocation(locationId, (scoped) => buildMenuSnapshot(locationId, scoped))
  const payload = await readActiveMenu(tx, locationId)
  return insertWithNextVersion(tx, locationId, payload)
}

/** One relational query down the whole chain, ordered so two builds of an unchanged menu are byte-identical. */
async function readActiveMenu(tx: ScopedTx, locationId: string): Promise<MenuSnapshotPayload> {
  const active = await tx.query.menus.findMany({
    where: and(eq(menus.locationId, locationId), eq(menus.isActive, true)),
    columns: { id: true, name: true },
    orderBy: [asc(menus.name), asc(menus.id)],
    with: {
      categories: {
        columns: { id: true, name: true },
        orderBy: [asc(menuCategories.sort), asc(menuCategories.name), asc(menuCategories.id)],
        with: {
          items: {
            // is86d is carried into the payload; isActive means "off the menu", so it is not.
            where: eq(menuItems.isActive, true),
            columns: { id: true, name: true, basePriceCents: true, is86d: true },
            orderBy: [asc(menuItems.sort), asc(menuItems.name), asc(menuItems.id)],
            with: {
              modifierGroupLinks: {
                columns: { minOverride: true, maxOverride: true },
                orderBy: [asc(itemModifierGroups.sort), asc(itemModifierGroups.groupId)],
                with: {
                  group: {
                    columns: { id: true, name: true, minSelect: true, maxSelect: true, required: true },
                    with: {
                      options: {
                        where: eq(modifierOptions.isActive, true),
                        columns: { id: true, name: true, priceDeltaCents: true, is86d: true },
                        // modifier_options has no sort column, so name is the only stable order.
                        orderBy: [asc(modifierOptions.name), asc(modifierOptions.id)],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  })

  if (active.length === 0) throw new Error(`No active menu for location ${locationId}`)
  if (active.length > 1) {
    const names = active.map((m) => m.name).join(', ')
    throw new Error(`Location ${locationId} has more than one active menu (${names}); exactly one must be active to snapshot`)
  }

  const menu = active[0]
  return {
    menuId: menu.id,
    categories: menu.categories.map((category) => ({
      id: category.id,
      name: category.name,
      items: category.items.map((item) => ({
        id: item.id,
        name: item.name,
        basePriceCents: item.basePriceCents,
        is86d: item.is86d,
        modifierGroups: item.modifierGroupLinks.map((link): SnapshotModifierGroup => ({
          id: link.group.id,
          name: link.group.name,
          // Pin the rule that was actually enforced: the item's override, else the group's
          // own. `??`, not `||` — minOverride: 0 ("optional on this dish") is a real value.
          minSelect: link.minOverride ?? link.group.minSelect,
          maxSelect: link.maxOverride ?? link.group.maxSelect,
          // Not overridable per item, and it does not outrank minSelect. See the ruling
          // on SnapshotModifierGroup.required.
          required: link.group.required,
          options: link.group.options.map((option) => ({
            id: option.id,
            name: option.name,
            priceDeltaCents: option.priceDeltaCents,
            is86d: option.is86d,
          })),
        })),
      })),
    })),
  }
}

/**
 * Insert-only, by design — nothing in this codebase updates a snapshot.
 *
 * The version is computed inside the INSERT, so it is one statement. A transaction
 * is not the guarantee and never was: under READ COMMITTED two of them can both
 * read max=0. The unique (location_id, version) constraint is the guarantee; the
 * loser retries.
 *
 * The retry now happens inside a transaction, which changes what it has to do: a
 * failed statement poisons its transaction, and every statement after it raises
 * 25P02 instead of doing anything. So the insert runs inside a SAVEPOINT
 * (`tx.transaction()`), which rolls back on its own and leaves the surrounding
 * transaction — the caller's, possibly with an order half-written into it — usable.
 */
async function insertWithNextVersion(
  tx: ScopedTx,
  locationId: string,
  payload: MenuSnapshotPayload,
): Promise<{ id: string; version: number }> {
  const nextVersion = sql<number>`(
    select coalesce(max(${menuSnapshots.version}), 0) + 1
    from ${menuSnapshots} where ${menuSnapshots.locationId} = ${locationId}
  )`

  for (let attempt = 1; ; attempt++) {
    try {
      const [row] = await tx.transaction((sp) => sp.insert(menuSnapshots)
        .values({ locationId, version: nextVersion, payload })
        .returning({ id: menuSnapshots.id, version: menuSnapshots.version }))
      return row
    } catch (err) {
      if (attempt >= MAX_VERSION_ATTEMPTS || !isVersionRace(err)) throw err
      // Jittered backoff so a rush of concurrent builds doesn't collide in lockstep.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt))
    }
  }
}

/**
 * 23505 = unique violation; (location_id, version) is the only unique constraint
 * on the table. Drizzle wraps driver errors in DrizzleQueryError, so walk `cause`.
 * Exported so a test can feed it a real error from the driver rather than a guess.
 */
export function isVersionRace(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e != null && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: string }).code === '23505') return true
  }
  return false
}
