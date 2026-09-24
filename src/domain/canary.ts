import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { locations, organizations } from '@/db/schema'

/**
 * The synthetic canary's location: who it is, and how the canary finds it.
 *
 * Shared by the seeder (`scripts/seed-canary.ts`), which writes it, and the Inngest
 * function (`src/inngest/canary.ts`), which orders from it — so the two cannot disagree
 * about which org is the canary's or what its one dish costs.
 */

/** The org the canary location lives under. No Clerk org is ever linked to it, so no feed can open it. */
export const CANARY_ORG_SLUG = 'serveside-canary'

/**
 * The location's own phone — a column that is NOT NULL for every location, so the canary
 * has to carry one. **Fictional and unroutable twice over**: area code 555 is never
 * assigned, and 555-01xx is the range reserved for fiction. Nothing texts it anyway —
 * `locations.synthetic` is what every owner-facing path checks — so this is the
 * belt, not the braces.
 */
export const CANARY_LOCATION_PHONE = '+15555550100'

/**
 * **One cent.** The cheapest real price: every money path runs for real (tax is computed
 * and rounds half-up to zero at 8.875%, the totals invariant is asserted on the row) and
 * nothing is ever collected, because the order is pay-at-pickup and cancelled a minute
 * later.
 */
export const CANARY_ITEM_PRICE_CENTS = 1

export type CanaryLocation = { ok: true; locationId: string } | { ok: false; reason: string }

/**
 * The one synthetic location under the canary org — or, as a value rather than a throw,
 * why there is not exactly one. The canary records that reason as a failed run, so an
 * unseeded production pages us like any other breakage instead of silently doing nothing.
 *
 * **Both conditions, in SQL**: the org slug *and* `synthetic = true`. The canary's
 * clean-up cancels every open order at the location it is given; a real restaurant that
 * somehow ended up under this org must never be the one it finds.
 *
 * `organizations` and `locations` are the tenancy root and carry no RLS, so the stateless
 * driver reads them. The org slug is a parameter only so the suite can seed canaries of
 * its own under fresh orgs; production always asks for {@link CANARY_ORG_SLUG}.
 */
export async function findCanaryLocation(orgSlug: string = CANARY_ORG_SLUG): Promise<CanaryLocation> {
  const rows = await db()
    .select({ id: locations.id })
    .from(locations)
    .innerJoin(organizations, eq(locations.orgId, organizations.id))
    .where(and(eq(organizations.slug, orgSlug), eq(locations.synthetic, true)))
    .limit(2)

  if (rows.length === 0) {
    return { ok: false, reason: `no synthetic location under org ${orgSlug} — run npm run seed:canary` }
  }
  if (rows.length > 1) {
    return { ok: false, reason: `org ${orgSlug} has more than one synthetic location; the canary needs exactly one` }
  }
  return { ok: true, locationId: rows[0].id }
}
