import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum, primaryKey } from 'drizzle-orm/pg-core'
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
  address: text('address').notNull(),
  timezone: text('timezone').notNull(),
  phoneE164: text('phone_e164').notNull(),
  prepTimeMinutes: integer('prep_time_minutes').notNull().default(20),
  taxRateBps: integer('tax_rate_bps').notNull(),
  pickupEnabled: boolean('pickup_enabled').notNull().default(true),
  deliveryEnabled: boolean('delivery_enabled').notNull().default(false),
  stripeAccountId: text('stripe_account_id'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

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
