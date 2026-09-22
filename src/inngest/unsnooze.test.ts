import { describe, it, expect, vi } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { InngestTestEngine } from '@inngest/test'
import type { GetStepTools } from 'inngest'
import { menus, menuItems, menuSnapshots, modifierOptions } from '@/db/schema'
import type { MenuSnapshot, SnapshotItem, SnapshotModifierOption } from '@/db/schema'
import { inngest as inngestClient } from '@/inngest/client'
import { withLocation } from '@/repo/scoped'
import { buildMenuSnapshot } from '@/domain/snapshot'
import { createOrder, type CreateOrderResult } from '@/domain/create-order'
import { seedLocationWithMenu, seedBusinessHours, type SeededMenu } from '@/test/seed'

/**
 * The other half of the two-tap 86: it puts itself back.
 *
 * An owner taps "until tomorrow" at 9pm and does nothing else, ever. If this job does
 * not run, the dish is still sold out at lunch — and nobody notices until a customer
 * asks for it. So the assertions here are about the *order path*: the proof that a
 * flag was cleared is that `createOrder` takes the dish again.
 *
 * Two things the harness cannot do, and how they are handled:
 *
 * - **The location scan is mocked, never run.** `list-locations` is a step precisely
 *   so it can be, and it has to be: the shared `test` branch has thousands of
 *   locations left by every run that ever happened, and a real scan would open a
 *   transaction against each. One test below runs the real lister on its own to prove
 *   it is not a stub.
 * - **A failed step is swallowed by `@inngest/test` rather than delivered to the
 *   function body**, so the "one location is broken" case is driven through a
 *   two-line fake `step`, exactly as `order-created.test.ts` does.
 */
const { unsnooze, unsnoozeExpired, listLocationIds, UNSNOOZE_CRON } = await import('./unsnooze')

const HOUR_MS = 60 * 60_000

/** Open all week, so a refused order is about the 86 and nothing else. */
async function restaurant(): Promise<SeededMenu> {
  const loc = await seedLocationWithMenu()
  await seedBusinessHours(loc.id)
  return loc
}

function optionNamed(loc: SeededMenu, name: string) {
  const option = loc.modifierOptions.find((o) => o.name === name)
  if (!option) throw new Error(`the seeded menu has no ${name} option`)
  return option
}

function placeOrder(loc: SeededMenu, optionIds?: string[]): Promise<CreateOrderResult> {
  return createOrder({
    locationId: loc.id,
    channel: 'web',
    fulfillment: 'pickup',
    contact: { name: 'Rohan R', phone: '+15551234567' },
    items: [{
      menuItemId: loc.items[0].id,
      qty: 1,
      modifierOptionIds: optionIds ?? [optionNamed(loc, 'Mild').id],
    }],
    tipCents: 0,
    payment: 'pay_on_pickup',
  })
}

/** 86 a dish with a deadline of our choosing — the route's own 6am math is tested elsewhere. */
function snoozeItem(locationId: string, itemId: string, unsnoozeAt: Date | null): Promise<unknown> {
  return withLocation(locationId, (tx) => tx.update(menuItems)
    .set({ is86d: true, unsnoozeAt })
    .where(eq(menuItems.id, itemId)))
}

function snoozeOption(locationId: string, optionId: string, unsnoozeAt: Date | null): Promise<unknown> {
  return withLocation(locationId, (tx) => tx.update(modifierOptions)
    .set({ is86d: true, unsnoozeAt })
    .where(eq(modifierOptions.id, optionId)))
}

function liveItem(locationId: string, itemId: string) {
  return withLocation(locationId, async (tx) => {
    const [row] = await tx.select().from(menuItems).where(eq(menuItems.id, itemId))
    return row
  })
}

function liveOption(locationId: string, optionId: string) {
  return withLocation(locationId, async (tx) => {
    const [row] = await tx.select().from(modifierOptions).where(eq(modifierOptions.id, optionId))
    return row
  })
}

function currentSnapshot(locationId: string): Promise<MenuSnapshot | undefined> {
  return withLocation(locationId, async (tx) => {
    const [row] = await tx.select().from(menuSnapshots)
      .where(eq(menuSnapshots.locationId, locationId))
      .orderBy(desc(menuSnapshots.version))
      .limit(1)
    return row
  })
}

function pinnedItem(snapshot: MenuSnapshot, itemId: string): SnapshotItem {
  const item = snapshot.payload.categories.flatMap((c) => c.items).find((i) => i.id === itemId)
  if (!item) throw new Error(`snapshot v${snapshot.version} does not contain item ${itemId}`)
  return item
}

function pinnedOption(snapshot: MenuSnapshot, optionId: string): SnapshotModifierOption {
  const option = snapshot.payload.categories
    .flatMap((c) => c.items)
    .flatMap((i) => i.modifierGroups)
    .flatMap((g) => g.options)
    .find((o) => o.id === optionId)
  if (!option) throw new Error(`snapshot v${snapshot.version} does not contain option ${optionId}`)
  return option
}

/**
 * A `step` that simply runs the work, except that the scan is answered with this
 * test's own locations. `seen` collects the step ids, which is the only honest way to
 * count them — the harness re-executes steps of its own accord, so call counts
 * through `InngestTestEngine` are not pinnable.
 */
function fakeStep(locationIds: string[], seen: string[] = []): GetStepTools<typeof inngestClient> {
  return {
    run: (id: string, fn: () => Promise<unknown>) => {
      seen.push(id)
      return id === 'list-locations' ? Promise.resolve(locationIds) : fn()
    },
  } as unknown as GetStepTools<typeof inngestClient>
}

/** The run's failure, flattened — the engine hands back a serialized error, not an `Error`. */
function failure(out: { error?: unknown }): string {
  const err = out.error as { name?: string; message?: string } | undefined
  return err ? `${err.name ?? 'Error'}: ${err.message ?? ''}` : ''
}

describe('the hourly unsnooze', () => {
  it('runs on the hour, every hour', () => {
    // Hourly and UTC rather than `0 6 * * *` in some zone: every restaurant has its
    // own 6am, and the job's business is `unsnooze_at <= now`, which is an instant.
    expect(UNSNOOZE_CRON).toBe('0 * * * *')
  })

  it('puts back a dish whose snooze has passed, and repins the menu', async () => {
    const loc = await restaurant()
    const before = await buildMenuSnapshot(loc.id)
    await snoozeItem(loc.id, loc.items[0].id, new Date(Date.now() - HOUR_MS))

    const out = await new InngestTestEngine({
      function: unsnooze,
      steps: [{ id: 'list-locations', handler: () => [loc.id] }],
    }).execute({ disableImmediateExecution: true })
    expect(failure(out)).toBe('')

    // The assertion that matters: the dish is orderable again, read live by the path
    // that takes money.
    await expect(placeOrder(loc)).resolves.toMatchObject({ status: 'NEW' })

    const live = await liveItem(loc.id, loc.items[0].id)
    expect(live.is86d).toBe(false)
    // Cleared with the flag, or the next run would clear it again and rebuild a
    // snapshot for a menu nobody changed, hourly, forever.
    expect(live.unsnoozeAt).toBeNull()

    // Rebuilt exactly once, and the new payload agrees with the live row. Without
    // this the order that lands at 6:05am pins evidence saying the dish was sold out.
    const after = await currentSnapshot(loc.id)
    expect(after?.version).toBe(before.version + 1)
    expect(pinnedItem(after!, loc.items[0].id).is86d).toBe(false)
  })

  it('puts back a topping too', async () => {
    const loc = await restaurant()
    const mild = optionNamed(loc, 'Mild')
    const before = await buildMenuSnapshot(loc.id)
    await snoozeOption(loc.id, mild.id, new Date(Date.now() - HOUR_MS))

    const summary = await unsnoozeExpired(fakeStep([loc.id]))

    expect(summary.unsnoozed).toEqual([
      { locationId: loc.id, items: 0, options: 1, snapshotVersion: before.version + 1 },
    ])
    await expect(placeOrder(loc, [mild.id])).resolves.toMatchObject({ status: 'NEW' })
    expect((await liveOption(loc.id, mild.id)).is86d).toBe(false)
    expect(pinnedOption((await currentSnapshot(loc.id))!, mild.id).is86d).toBe(false)
  })

  it('leaves a live snooze and an indefinite 86 exactly where they are', async () => {
    // The two states that must survive: a dish 86d until tomorrow morning, and one
    // 86d with no end date at all ("we are not making this again this season"). A
    // `unsnooze_at <= now` that matched NULL would put the second back every hour.
    const loc = await restaurant()
    const before = await buildMenuSnapshot(loc.id)
    await snoozeItem(loc.id, loc.items[0].id, new Date(Date.now() + 6 * HOUR_MS))
    await snoozeItem(loc.id, loc.items[1].id, null)

    const summary = await unsnoozeExpired(fakeStep([loc.id]))

    expect(summary.unsnoozed).toEqual([])
    expect((await liveItem(loc.id, loc.items[0].id)).is86d).toBe(true)
    expect((await liveItem(loc.id, loc.items[1].id)).is86d).toBe(true)
    // Nothing changed, so nothing was pinned: an insert-only table must not grow a
    // row an hour for every restaurant on the platform.
    expect((await currentSnapshot(loc.id))?.version).toBe(before.version)
  })

  it('touches only the locations that had something to clear', async () => {
    const cleared = await restaurant()
    const untouched = await restaurant()
    const clearedBefore = await buildMenuSnapshot(cleared.id)
    const untouchedBefore = await buildMenuSnapshot(untouched.id)
    await snoozeItem(cleared.id, cleared.items[0].id, new Date(Date.now() - HOUR_MS))
    await snoozeItem(untouched.id, untouched.items[0].id, new Date(Date.now() + HOUR_MS))

    const steps: string[] = []
    const summary = await unsnoozeExpired(fakeStep([cleared.id, untouched.id], steps))

    // Two steps whatever the platform grows to, not one per restaurant: a step each
    // would be `locations × 24 × 30` a month of almost entirely nothing. Per-location
    // retries are not lost by this — a retry finds the ones that already succeeded
    // with nothing left to clear.
    expect(steps).toEqual(['list-locations', 'unsnooze-locations'])

    expect(summary.scanned).toBe(2)
    expect(summary.unsnoozed).toEqual([
      { locationId: cleared.id, items: 1, options: 0, snapshotVersion: clearedBefore.version + 1 },
    ])
    expect((await currentSnapshot(untouched.id))?.version).toBe(untouchedBefore.version)
    expect((await liveItem(untouched.id, untouched.items[0].id)).is86d).toBe(true)
  })

  it('clears the flags even when the menu cannot be pinned, and says so out loud', async () => {
    // A location with two active menus cannot be snapshotted — and it cannot take an
    // order either, so nothing can pin the stale payload while it stays that way. What
    // must not happen is the clear rolling back with the rebuild: the dish would stay
    // sold out until somebody noticed, and the job would fail on that location every
    // hour forever.
    //
    // Nothing on this branch repairs the skipped snapshot afterwards (there is no menu
    // editor yet — see the TODO in `unsnoozeLocation`), so the warn line is the only
    // trace it leaves: the run is green and the summary is read by nobody. It is
    // asserted here so a later tidy-up cannot delete the one thing that would tell an
    // operator a location is carrying evidence that understates what it can sell.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const loc = await restaurant()
      await snoozeItem(loc.id, loc.items[0].id, new Date(Date.now() - HOUR_MS))
      await withLocation(loc.id, (tx) => tx.insert(menus).values({ locationId: loc.id, name: 'Late Night' }))

      const summary = await unsnoozeExpired(fakeStep([loc.id]))

      expect(summary.unsnoozed).toEqual([
        { locationId: loc.id, items: 1, options: 0, snapshotVersion: null },
      ])
      // The flags really did go back, which is the half of this that matters to a
      // customer standing at the counter.
      expect((await liveItem(loc.id, loc.items[0].id)).is86d).toBe(false)
      await expect(placeOrder(loc)).rejects.toThrow(/active menus/i)
      expect(await currentSnapshot(loc.id)).toBeUndefined()

      expect(warn).toHaveBeenCalledWith(
        '[unsnooze] rebuild skipped, snapshot now stale',
        { locationId: loc.id, activeMenuCount: 2, cleared: 1 },
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('carries on past a location it cannot clear, and ends the run red naming it', async () => {
    // Broken by handing the job something `withLocation` refuses to open. What is
    // under test is the catch-and-continue, not this particular failure: whatever
    // goes wrong for one restaurant — a dead connection, a poisoned transaction —
    // must not leave every other restaurant's dishes sold out for another hour.
    const healthy = await restaurant()
    await snoozeItem(healthy.id, healthy.items[0].id, new Date(Date.now() - HOUR_MS))

    await expect(unsnoozeExpired(fakeStep(['not-a-location', healthy.id])))
      .rejects.toThrow(/not-a-location/)

    expect((await liveItem(healthy.id, healthy.items[0].id)).is86d).toBe(false)
    await expect(placeOrder(healthy)).resolves.toMatchObject({ status: 'NEW' })
  })

  it('scans every location for real when nothing mocks the list', async () => {
    // The one unmocked look at the scan, kept to a single query: a lister that
    // returned [] would make every test above pass against a job that does nothing.
    const loc = await restaurant()
    expect(await listLocationIds()).toContain(loc.id)
  })
})
