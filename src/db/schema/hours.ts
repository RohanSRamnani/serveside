import { pgTable, uuid, text, integer, time, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { locations } from './tenancy'

/**
 * The weekly grid. Wall-clock local times, read in `locations.timezone` — a row
 * says "17:00 at this restaurant", never an instant.
 *
 * **Deliberately not unique on (location_id, dow):** split service is the norm,
 * not the exception. Lunch 11:30–15:00 and dinner 17:00–22:00 are two Tuesday
 * rows, and a constraint here would force every client onto one block a day.
 *
 * A range never wraps past midnight — `isOpenAt` compares `open <= local < close`
 * within one local day. Post a 17:00–02:00 shift as two rows: Tue 17:00–24:00
 * (Postgres `time` accepts 24:00:00) plus Wed 00:00–02:00.
 *
 * The CHECK is what makes that convention safe rather than merely documented: a
 * wrap-around row reads as an ordinary dinner service to whoever typed it, but
 * `22:00 <= t AND t < 02:00` is true for no instant at all, so the location would
 * report closed for the whole day and nothing would say why.
 */
export const businessHours = pgTable('business_hours', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  /** 0 = Sunday, matching JS `Date#getDay`. */
  dow: integer('dow').notNull(),
  openTime: time('open_time').notNull(),
  /** Exclusive: an order must not land on the stroke of close. */
  closeTime: time('close_time').notNull(),
}, (t) => [
  // Strict `>`: a zero-length range is as unorderable as a wrapped one.
  check('business_hours_no_midnight_wrap', sql`${t.closeTime} > ${t.openTime}`),
]).enableRLS()

/**
 * Dated overrides of the weekly grid — Thanksgiving, a private event, a flood.
 * Instants, not wall clocks: the owner picks a date range in the dashboard and
 * the UI resolves it to timestamps. `startsAt` inclusive, `endsAt` exclusive, so
 * a closure that ends at 17:00 lets the 17:00 service open.
 */
export const holidayClosures = pgTable('holiday_closures', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  /** Nullable: worth showing the customer when it exists, never worth blocking on. */
  reason: text('reason'),
}).enableRLS()

/**
 * The "we're slammed, stop taking orders" button, with auto-resume.
 *
 * `until` is what expires a pause, so a stale row can never keep a location dark and
 * no job has to remember to lift one.
 *
 * **Resuming early shortens the live rows' `until` to now** (`DELETE /api/pause`) —
 * not a delete, and *not* a new row with a past `until`: `isOpenAt` reports paused if
 * **any** row has `until > now`, so an extra row cannot cancel an existing one. Every
 * live row is shortened, because two taps in a rush is two rows. What that preserves
 * is the history — the reason, the moment, and who stopped taking orders.
 */
export const orderPauses = pgTable('order_pauses', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  until: timestamp('until', { withTimezone: true }).notNull(),
  reason: text('reason'),
  /** Clerk user id, as in `memberships.userId`. Null = paused by the system. */
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}).enableRLS()

export type BusinessHours = typeof businessHours.$inferSelect
export type HolidayClosure = typeof holidayClosures.$inferSelect
export type OrderPause = typeof orderPauses.$inferSelect
