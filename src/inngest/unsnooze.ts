import type { GetStepTools } from 'inngest'
import { db } from '@/db/client'
import { locations } from '@/db/schema'
import { buildMenuSnapshot } from '@/domain/snapshot'
import { menuRepo } from '@/repo/menu-repo'
import { withLocation } from '@/repo/scoped'
import { inngest } from './client'

/**
 * The other half of the two-tap 86: it puts itself back.
 *
 * An owner taps "until tomorrow" at 9pm and then does nothing, ever — that is the
 * whole promise of the button, and this job is the only thing keeping it. Without it
 * the dish is still sold out at lunch and nobody finds out until a customer asks for
 * something the kitchen has plenty of.
 *
 * **Hourly and in UTC (`0 * * * *`), not `0 6 * * *` in somebody's zone.** Every
 * restaurant has its own 6am; what they share is an instant. The deadline is decided
 * when the 86 is set (`nextLocalHour(..., 6)` in the location's own timezone) and this
 * job's only business is `unsnooze_at <= now`. So it is right for every zone at once,
 * and a location that changes timezone does not strand a snoozed dish. The cost is at
 * most 59 minutes of a dish staying off past its deadline, before doors open.
 *
 * **Every location that clears something gets its snapshot rebuilt, once**, in the
 * same transaction as the clear — the controller's standing ruling for every menu
 * mutation. Orders pin the *current* snapshot, so a 6am unsnooze that did not rebuild
 * would leave the 6:05 order pinning evidence saying a dish nobody could order was
 * sold out. Locations with nothing to clear are not touched at all: `menu_snapshots`
 * is insert-only, and a row an hour per restaurant for a menu nobody changed is a
 * table that grows for nothing.
 */
export const UNSNOOZE_CRON = '0 * * * *'

/** What one location's hour of work came to. `snapshotVersion` is null when none was pinned. */
export type LocationUnsnooze = {
  locationId: string
  items: number
  options: number
  snapshotVersion: number | null
}

export type UnsnoozeSummary = {
  /** Locations looked at. Every location, every hour — see `listLocationIds`. */
  scanned: number
  /** Only the ones that actually had something to put back. */
  unsnoozed: LocationUnsnooze[]
}

export const unsnooze = inngest.createFunction(
  { id: 'unsnooze-expired-86s', name: 'Unsnooze expired 86s', triggers: { cron: UNSNOOZE_CRON } },
  ({ step }) => unsnoozeExpired(step),
)

/**
 * The job itself, one step-tool short of being an Inngest function — split out for
 * the same reason `fanOut` is: `@inngest/test` settles a run at the first errored step
 * and never delivers a mocked failure to the function body, so the failure paths can
 * only be driven with a `step` of the test's own making.
 *
 * The scan is a step of its own so a test can answer it with the locations it seeded.
 * That is not only a convenience: the shared `test` branch holds thousands of
 * locations left by every run that ever happened.
 *
 * **Two steps, not one per location**, and the arithmetic is the argument: a step per
 * location is `locations × 24 × 30` steps a month of almost entirely nothing — at
 * fifty restaurants, tens of thousands — plus one function invocation each, since
 * Inngest re-executes the body to reach the next step. What a step per location would
 * buy is retrying only the restaurant that failed, and this job gets that for free
 * anyway: clearing is the state change and the rebuild is gated on it, so a retry
 * finds the locations that already succeeded with nothing left to clear and does
 * nothing for them. The summary a retry returns is thinner than the work that
 * happened, which is observability, not correctness.
 */
export async function unsnoozeExpired(step: GetStepTools<typeof inngest>): Promise<UnsnoozeSummary> {
  const locationIds = await step.run('list-locations', listLocationIds)
  return step.run('unsnooze-locations', () => unsnoozeAll(locationIds))
}

/** Every location in turn, one transaction each — see `unsnoozeLocation`. */
async function unsnoozeAll(locationIds: string[]): Promise<UnsnoozeSummary> {
  const unsnoozed: LocationUnsnooze[] = []
  const failures: string[] = []

  for (const locationId of locationIds) {
    try {
      const result = await unsnoozeLocation(locationId)
      if (result.items + result.options > 0) unsnoozed.push(result)
    } catch (err) {
      // Caught rather than thrown on the spot: one restaurant's database trouble must
      // not hold every other restaurant's lunch — the same ruling the order fan-out
      // makes about its two legs. The run still ends red, below.
      failures.push(`${locationId}: ${describe(err)}`)
    }
  }

  // Named, not counted: "the unsnooze failed" is not an actionable sentence, and which
  // restaurant still has a dish wrongly off its menu is the first thing anyone needs.
  if (failures.length > 0) {
    throw new Error(`unsnooze incomplete — ${failures.join('; ')}`)
  }
  return { scanned: locationIds.length, unsnoozed }
}

/**
 * One location's expired 86s, cleared and repinned in a single transaction.
 *
 * **The clear is not conditional on the rebuild.** A location that cannot be
 * snapshotted — no active menu, or two — cannot take an order either, so there is no
 * pinned evidence for a stale payload to contaminate; whereas rolling the clear back
 * would leave the dish sold out and fail this location every hour, forever. So the
 * flags go back and the skipped rebuild is reported as `snapshotVersion: null`.
 *
 * TODO(plan-2/menu-editor): no compensation exists yet — a location skipped here keeps
 * a stale snapshot (is86d=true for a dish that's back on sale) until its next menu
 * mutation. The Plan-2 menu editor MUST rebuild on menu activation/deactivation, and
 * Plan 2 adds a reconciliation sweep. Evidence errs toward understating availability;
 * no pricing consequence.
 */
async function unsnoozeLocation(locationId: string): Promise<LocationUnsnooze> {
  return withLocation(locationId, async (tx) => {
    const repo = menuRepo(tx)
    // `now` is read here, inside the step, rather than being threaded down from the
    // run: a retried step should see everything that has expired since, not replay an
    // hour-old instant.
    const { items, options } = await repo.clearExpired86s(new Date())
    if (items + options === 0) return { locationId, items, options, snapshotVersion: null }

    const activeMenus = await repo.activeMenuIds()
    if (activeMenus.length !== 1) {
      // One greppable line, because this is the only trace the stale snapshot leaves:
      // the run is green (the clear worked), the summary says `snapshotVersion: null`
      // in a place nobody reads, and nothing else will mention it until the location's
      // next menu mutation — which, per the TODO above, nothing on this branch
      // performs. Structured so a log-based alert can be hung off it; the SMS alarms
      // deliberately cover orders and printers only — this is a menu understating
      // itself, not a service that has stopped.
      console.warn('[unsnooze] rebuild skipped, snapshot now stale', {
        locationId,
        activeMenuCount: activeMenus.length,
        cleared: items + options,
      })
      return { locationId, items, options, snapshotVersion: null }
    }

    const snapshot = await buildMenuSnapshot(locationId, tx)
    return { locationId, items, options, snapshotVersion: snapshot.version }
  })
}

/**
 * Every location on the platform, because there is no way to ask a narrower question.
 * `menu_items` carries no `location_id` — it is policed through its parents — and an
 * unscoped read of it under RLS returns nothing at all, so "which locations have an
 * expired 86" cannot be asked before a scope is open. `locations` is the tenancy root
 * and carries no RLS, which is why this read works at all.
 *
 * TODO(scale): one transaction per location per hour, all inside one step. Fine into
 * the low hundreds and wrong in the thousands — where it would also outrun a
 * serverless invocation's time limit. The fix is a second SECURITY DEFINER function
 * returning only the location ids with expired snoozes, which — see CLAUDE.md — has
 * to be argued for by name in `src/repo/rls.test.ts` before it exists.
 */
export async function listLocationIds(): Promise<string[]> {
  const rows = await db().select({ id: locations.id }).from(locations)
  return rows.map((row) => row.id)
}

/** A failure's reason, flattened for one line of a report. */
function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
