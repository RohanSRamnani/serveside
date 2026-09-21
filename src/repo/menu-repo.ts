import { asc, eq } from 'drizzle-orm'
import { menus, menuCategories, menuItems, modifierOptions, itemModifierGroups } from '@/db/schema'
import type { ScopedTx } from './scoped'

/**
 * Reads and writes for one location's menu.
 *
 * As in `ordersRepo`, nothing here filters on `location_id`: the transaction
 * carries the scope and RLS supplies the predicate, down the whole chain —
 * `menu_categories`, `menu_items`, `modifier_options` and `item_modifier_groups`
 * have no `location_id` column at all and are policed through their parents.
 */
export function menuRepo(tx: ScopedTx) {
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
     * 86s an item — sold out — until `until`, or indefinitely when that is null.
     * A nightly job clears the ones whose `unsnoozeAt` has passed.
     *
     * Returns the updated row, or `undefined` when nothing matched: an id from
     * another location does not raise here, it simply is not in scope, and a caller
     * that ignores the return value would report success for a no-op.
     */
    async set86(itemId: string, until: Date | null) {
      const [row] = await tx.update(menuItems)
        .set({ is86d: true, unsnoozeAt: until })
        .where(eq(menuItems.id, itemId))
        .returning()
      return row
    },
  }
}

export type MenuRepo = ReturnType<typeof menuRepo>
