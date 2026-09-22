import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum, primaryKey, unique } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

export const membershipRole = pgEnum('membership_role', ['owner', 'manager', 'staff'])

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  clerkOrgId: text('clerk_org_id').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  /**
   * **The public routing key, and it is platform-unique** — `/order/<storefront_slug>`
   * and `GET /api/storefront/<storefront_slug>`.
   *
   * A second slug rather than a stricter `slug`, because the two keys answer two
   * different questions and only one of them is asked by a stranger:
   *
   * - `slug` is **internal and org-scoped**. Everything behind the login resolves the
   *   Clerk org first and the slug inside it (`requireLocationAccess`), so two
   *   restaurants may both call a location `main` — and taking that away would push
   *   `kashi-main` into every staff URL for nothing.
   * - `storefront_slug` is **public**. A customer has no org to resolve inside, so
   *   this is the one slug-first lookup in the codebase and it cannot be allowed to
   *   match two rows: one restaurant's menu at another's URL sends real food to the
   *   wrong kitchen and real money to the wrong Stripe account. The uniqueness is the
   *   guarantee; the route's refusal branch is only the belt.
   *
   * It is also what lets the customer-facing URL read the way the restaurant's name
   * does: Kashi's location slug is `livingston` (their street) and their storefront
   * slug is `kashi`. A second Kashi location would read `kashi-livingston`.
   */
  storefrontSlug: text('storefront_slug').notNull(),
  address: text('address').notNull(),
  timezone: text('timezone').notNull(),
  phoneE164: text('phone_e164').notNull(),
  prepTimeMinutes: integer('prep_time_minutes').notNull().default(20),
  /**
   * Sales tax, in **parts per 100,000** — 8875 is 8.875%, New York City's rate on
   * prepared food. Not basis points, and the difference is not pedantry: this column
   * started life as `tax_rate_bps`, and NYC's rate is not expressible in whole basis
   * points at all (8.875% is 887.5 bps). An integer column in that unit cannot hold
   * the rate of the city we are launching in, so every location in it would have been
   * charged 8.75% or 8.9%. Re-united 2026-09-21 (`drizzle/0019_tax_rate_per_100k.sql`),
   * which multiplied every existing value by ten.
   *
   * Integer, still: the alternative is `numeric`, and a rate read back as a string or
   * a float is a rounding opinion in the one place this codebase refuses to have one.
   * Per 100,000 covers every US jurisdiction — rates are quoted to at most three
   * decimal places — and `taxCentsFor` divides by exactly that.
   */
  taxRatePer100k: integer('tax_rate_per_100k').notNull(),
  pickupEnabled: boolean('pickup_enabled').notNull().default(true),
  deliveryEnabled: boolean('delivery_enabled').notNull().default(false),
  stripeAccountId: text('stripe_account_id'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  /**
   * **Unique per org, not globally** — two restaurants may both call a location
   * `main`, and taking that away would force slugs like `kashi-main` into every URL.
   *
   * Load-bearing rather than tidy. Everything behind the kitchen feed resolves a
   * location the same way (`src/lib/authz.ts`): the Clerk session's active org →
   * `organizations.clerk_org_id` → the org's own location with this slug. Without
   * this constraint that lookup can match two rows, and which one it picks — which
   * restaurant's orders a tablet shows — would be up to the planner.
   */
  unique('locations_org_slug_unique').on(t.orgId, t.slug),
  /**
   * **Platform-wide, unlike the one above**, and that asymmetry is the whole reason
   * the column exists. See `storefrontSlug` for why a public key cannot be scoped to
   * an org, and `drizzle/0020_locations_storefront_slug.sql` for how the existing
   * rows were given one.
   */
  unique('locations_storefront_slug_unique').on(t.storefrontSlug),
])

export const memberships = pgTable('memberships', {
  userId: text('user_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').references(() => locations.id),
  role: membershipRole('role').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.orgId] })])

export const organizationsRelations = relations(organizations, ({ many }) => ({ locations: many(locations) }))
export const locationsRelations = relations(locations, ({ one }) => ({
  org: one(organizations, { fields: [locations.orgId], references: [organizations.id] }),
}))

export type Organization = typeof organizations.$inferSelect
export type Location = typeof locations.$inferSelect
