import { and, asc, eq, lte } from 'drizzle-orm'
import { menus, menuCategories, menuItems, modifierOptions, itemModifierGroups } from '@/db/schema'
import type { ScopedTx } from './scoped'

/**
 * What a 86 points at. A dish and a topping are the same action to the person
 * tapping — "we're out of it" — and running out of paneer is as ordinary as running
 * out of a dish, so both are one endpoint and one repo method rather than two of each.
 */
export type EightySixTarget = { kind: 'item'; id: string } | { kind: 'option'; id: string }

/** The 86 state of one row, shaped the same whichever table it came from. */
export type EightySixed = { id: string; is86d: boolean; unsnoozeAt: Date | null }

/**
 * Reads and writes for one location's menu.
 *
 * As in `ordersRepo`, nothing here filters on `location_id`: the transaction
 * carries the scope and RLS supplies the predicate, down the whole chain —
 * `menu_categories`, `menu_items`, `modifier_options` and `item_modifier_groups`
 * have no `location_id` column at all and are policed through their parents.
 */
export function menuRepo(tx: ScopedTx) {
  /**
   * One UPDATE against whichever of the two tables the target names, returning the
   * same three columns either way.
   *
   * `undefined` back means nothing matched — which is how an id from another location
   * arrives here, because RLS filters rather than raising. A caller that ignores the
   * return value reports success for a write that did nothing.
   */
  async function write86(target: EightySixTarget, values: Omit<EightySixed, 'id'>): Promise<EightySixed | undefined> {
    if (target.kind === 'item') {
      const [row] = await tx.update(menuItems).set(values).where(eq(menuItems.id, target.id))
        .returning({ id: menuItems.id, is86d: menuItems.is86d, unsnoozeAt: menuItems.unsnoozeAt })
      return row
    }
    const [row] = await tx.update(modifierOptions).set(values).where(eq(modifierOptions.id, target.id))
      .returning({ id: modifierOptions.id, is86d: modifierOptions.is86d, unsnoozeAt: modifierOptions.unsnoozeAt })
    return row
  }

  return {
    /**
     * The location's active menu with its categories, items and modifier groups,
     * ordered the way `buildMenuSnapshot` orders them so two reads of an unchanged
     * menu are identical.
     *
     * `undefined` when the location has no active menu. **Throws** when it has more
     * than one — the same ruling as `buildMenuSnapshot`: a menu that silently shows
     * half the dishes is worse than a loud failure, because people order from it.
     */
    async activeMenu() {
      const rows = await tx.query.menus.findMany({
        where: eq(menus.isActive, true),
        orderBy: [asc(menus.name), asc(menus.id)],
        with: {
          categories: {
            orderBy: [asc(menuCategories.sort), asc(menuCategories.name), asc(menuCategories.id)],
            with: {
              items: {
                where: eq(menuItems.isActive, true),
                orderBy: [asc(menuItems.sort), asc(menuItems.name), asc(menuItems.id)],
                with: {
                  modifierGroupLinks: {
                    orderBy: [asc(itemModifierGroups.sort), asc(itemModifierGroups.groupId)],
                    with: {
                      group: {
                        with: {
                          options: {
                            where: eq(modifierOptions.isActive, true),
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
      if (rows.length > 1) {
        throw new Error(`Location has more than one active menu (${rows.map((m) => m.name).join(', ')})`)
      }
      return rows[0]
    },

    /**
     * The ids of the location's active menus.
     *
     * 0 or 2 is not a detail: it is the state in which nothing can be snapshotted and
     * nothing can be sold (`createOrder` refuses outright), so a caller that is about
     * to rebuild the snapshot asks this first and says so, rather than letting
     * `buildMenuSnapshot` throw a plain Error on a route a person is tapping.
     */
    async activeMenuIds(): Promise<string[]> {
      const rows = await tx.select({ id: menus.id }).from(menus).where(eq(menus.isActive, true))
      return rows.map((row) => row.id)
    },

    /**
     * 86s a dish or a topping — sold out — until `unsnoozeAt`, or indefinitely when
     * that is null. The hourly job (`src/inngest/unsnooze.ts`) clears the ones whose
     * deadline has passed.
     *
     * Returns the updated row, or `undefined` when nothing matched: an id from
     * another location does not raise here, it simply is not in scope, and a caller
     * that ignores the return value would report success for a no-op.
     */
    set86(target: EightySixTarget, unsnoozeAt: Date | null): Promise<EightySixed | undefined> {
      return write86(target, { is86d: true, unsnoozeAt })
    },

    /**
     * Puts it back on sale by hand. The deadline is cleared **with** the flag: left
     * behind, it would give the hourly job a row to "clear" every hour, and with it a
     * snapshot to rebuild, for a menu nobody had changed.
     */
    clear86(target: EightySixTarget): Promise<EightySixed | undefined> {
      return write86(target, { is86d: false, unsnoozeAt: null })
    },

    /**
     * Everything in this location whose snooze has run out, put back in two
     * statements. Returns how many rows each table gave up, which is what tells the
     * caller whether the menu changed at all — and so whether to rebuild the snapshot.
     *
     * **An indefinite 86 has `unsnooze_at` NULL and must survive this**, which it does
     * for free: `NULL <= now` is NULL, not true, so those rows never match. The
     * `is_86d` predicate is what keeps the counts honest — a row that is already back
     * on sale is not a change, and must not provoke a snapshot rebuild.
     */
    async clearExpired86s(now: Date): Promise<{ items: number; options: number }> {
      const items = await tx.update(menuItems)
        .set({ is86d: false, unsnoozeAt: null })
        .where(and(eq(menuItems.is86d, true), lte(menuItems.unsnoozeAt, now)))
        .returning({ id: menuItems.id })
      const options = await tx.update(modifierOptions)
        .set({ is86d: false, unsnoozeAt: null })
        .where(and(eq(modifierOptions.is86d, true), lte(modifierOptions.unsnoozeAt, now)))
        .returning({ id: modifierOptions.id })
      return { items: items.length, options: options.length }
    },
  }
}

export type MenuRepo = ReturnType<typeof menuRepo>
