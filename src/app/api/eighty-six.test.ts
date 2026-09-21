import { describe, it, expect, beforeEach, vi } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { menus, menuItems, menuSnapshots, modifierOptions } from '@/db/schema'
import type { MenuSnapshot, SnapshotItem, SnapshotModifierOption } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { buildMenuSnapshot } from '@/domain/snapshot'
import {
  createOrder, ItemUnavailableError, OptionUnavailableError, type CreateOrderResult,
} from '@/domain/create-order'
import { seedLocationWithMenu, seedBusinessHours, linkClerkOrg, type SeededMenu } from '@/test/seed'

/**
 * The 86 button — the highest-frequency action in the product. Two taps, "until
 * tomorrow", and it puts itself back.
 *
 * Three things are under test, and the endpoint's own response is the least of them:
 *
 * - **The dish actually stops selling.** `createOrder` reads live rows inside its own
 *   transaction, so the only proof that a 86 worked is that an order for it is
 *   refused. Everything else is a row that looks right.
 * - **The snapshot is rebuilt in the same transaction.** Orders pin the *current*
 *   snapshot, so a 86 that does not rebuild leaves every later order pinning evidence
 *   that says the dish was on sale. The controller's ruling is that every menu
 *   mutation rebuilds, and the atomicity test below is what makes it one mutation
 *   rather than two things that usually both happen.
 * - **"Until tomorrow" is 6am at the restaurant**, not 6am wherever this process runs.
 *
 * `auth()` is the whole of Clerk here, as in `feed.test.ts`: the route asks who is
 * signed in and which org is active, and nothing else.
 */
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('@clerk/nextjs/server', () => ({ auth }))

const { POST, DELETE } = await import('./menu/86/route')

const USER_ID = 'user_test_owner'

function signedInAs(orgId: string | null, userId: string | null = USER_ID) {
  auth.mockResolvedValue({ userId, orgId })
}

/** The route as a tablet calls it. `body` is passed through raw when it is a string, so malformed JSON is reachable. */
function call(
  method: 'POST' | 'DELETE',
  slug: string | null,
  body: Record<string, unknown> | string,
): Promise<Response> {
  const url = new URL('https://serveside.test/api/menu/86')
  if (slug !== null) url.searchParams.set('location', slug)
  const handler = method === 'POST' ? POST : DELETE
  return handler(new Request(url, {
    method,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
}

/** A restaurant whose staff can sign in, open all week so nothing but a 86 can refuse an order. */
async function restaurant(overrides: Parameters<typeof seedLocationWithMenu>[0] = {}) {
  const loc = await seedLocationWithMenu(overrides)
  await seedBusinessHours(loc.id)
  const clerkOrgId = await linkClerkOrg(loc.orgId)
  return { ...loc, clerkOrgId }
}

function optionNamed(loc: SeededMenu, name: string) {
  const option = loc.modifierOptions.find((o) => o.name === name)
  if (!option) throw new Error(`the seeded menu has no ${name} option`)
  return option
}

/** Butter Chicken with its one mandatory spice choice: the simplest order the seeded menu allows. */
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

/** The newest pinned menu, or undefined when the location has never had one. */
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

/** The live row, read in its own location's scope — what `createOrder` would see. */
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

/** An instant as the wall clock reads it at the restaurant. */
function localClock(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(at)
}

const THIRTY_HOURS_MS = 30 * 60 * 60_000

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/menu/86', () => {
  it('86s a dish until tomorrow, and the dish stops selling', async () => {
    const loc = await restaurant()
    signedInAs(loc.clerkOrgId)

    const res = await call('POST', loc.slug, { itemId: loc.items[0].id, until: 'tomorrow' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.target).toEqual({ kind: 'item', id: loc.items[0].id })
    expect(body.is86d).toBe(true)

    // The assertion the whole feature exists for. `createOrder` reads live rows inside
    // its own transaction, so this is the only proof that the toggle reached the path
    // that takes money.
    await expect(placeOrder(loc)).rejects.toBeInstanceOf(ItemUnavailableError)

    // "Until tomorrow" is 6am at the restaurant — never 6am on this machine. A New
    // York restaurant 86ing at 11pm must get its dish back before the lunch prep, and
    // a naive `+1 day` would put it back at 11pm tomorrow instead.
    const unsnoozeAt = new Date(body.unsnoozeAt)
    expect(localClock(unsnoozeAt, loc.timezone)).toBe('06:00:00')
    expect(unsnoozeAt.getTime()).toBeGreaterThan(Date.now())
    expect(unsnoozeAt.getTime()).toBeLessThan(Date.now() + THIRTY_HOURS_MS)

    expect((await liveItem(loc.id, loc.items[0].id)).unsnoozeAt?.getTime()).toBe(unsnoozeAt.getTime())
  })

  it('rebuilds the snapshot in the same breath, so the pinned menu agrees with the live one', async () => {
    // The controller's standing ruling: every menu mutation rebuilds the location's
    // snapshot. Orders pin the *current* snapshot rather than building one each, so a
    // 86 that skipped this would leave every later order pinning evidence that says
    // the dish was on sale — correct prices, a lie about availability.
    const loc = await restaurant()
    const before = await buildMenuSnapshot(loc.id)
    signedInAs(loc.clerkOrgId)

    const body = await (await call('POST', loc.slug, { itemId: loc.items[0].id, until: 'manual' })).json()
    expect(body.snapshot.version).toBe(before.version + 1)
    expect(body.unsnoozeAt).toBeNull()

    const after = await currentSnapshot(loc.id)
    expect(after?.version).toBe(before.version + 1)
    expect(after?.id).toBe(body.snapshot.id)
    expect(pinnedItem(after!, loc.items[0].id).is86d).toBe(true)
    // And the version it superseded still says otherwise — snapshots are insert-only.
    expect(pinnedItem((await snapshotVersion(loc.id, before.version))!, loc.items[0].id).is86d).toBe(false)
  })

  it('86s a topping too — running out of paneer is as ordinary as running out of a dish', async () => {
    const loc = await restaurant()
    const mild = optionNamed(loc, 'Mild')
    signedInAs(loc.clerkOrgId)

    const res = await call('POST', loc.slug, { modifierOptionId: mild.id, until: 'tomorrow' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.target).toEqual({ kind: 'option', id: mild.id })

    await expect(placeOrder(loc, [mild.id])).rejects.toBeInstanceOf(OptionUnavailableError)
    // The dish itself is untouched: the other spice level still sells it.
    await expect(placeOrder(loc, [optionNamed(loc, 'Hot').id])).resolves.toMatchObject({ status: 'NEW' })

    const snapshot = await currentSnapshot(loc.id)
    expect(pinnedOption(snapshot!, mild.id).is86d).toBe(true)
    expect(localClock(new Date(body.unsnoozeAt), loc.timezone)).toBe('06:00:00')
  })

  it('leaves the toggle and the rebuild as one transaction — neither lands without the other', async () => {
    // A location with two active menus cannot be snapshotted at all (a menu that
    // silently shows half the dishes is worse than a loud refusal), which is the one
    // reachable way to make the rebuild fail. The 86 must roll back with it: a dish
    // flagged sold-out against a snapshot that never moved is exactly the split state
    // the same-transaction rule exists to forbid.
    const loc = await restaurant()
    const before = await buildMenuSnapshot(loc.id)
    await withLocation(loc.id, (tx) => tx.insert(menus).values({ locationId: loc.id, name: 'Late Night' }))
    signedInAs(loc.clerkOrgId)

    const res = await call('POST', loc.slug, { itemId: loc.items[0].id, until: 'tomorrow' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('menu_unavailable')

    expect((await liveItem(loc.id, loc.items[0].id)).is86d).toBe(false)
    expect((await currentSnapshot(loc.id))?.version).toBe(before.version)
  })

  it('refuses another restaurant\'s dish without touching it, and pins nothing', async () => {
    // RLS filters rather than raising, so the write simply matches no row. The danger
    // is a route that reads "no error" as "it worked" — and then rebuilds a snapshot
    // for a location whose menu did not change.
    const mine = await restaurant()
    const theirs = await restaurant()
    signedInAs(mine.clerkOrgId)

    const res = await call('POST', mine.slug, { itemId: theirs.items[0].id, until: 'tomorrow' })
    expect(res.status).toBe(404)

    // And the topping, which RLS reaches by a different chain: an option is policed
    // through its modifier group, an item through its category and menu.
    const theirMild = optionNamed(theirs, 'Mild')
    expect((await call('POST', mine.slug, { modifierOptionId: theirMild.id, until: 'tomorrow' })).status).toBe(404)

    expect((await liveItem(theirs.id, theirs.items[0].id)).is86d).toBe(false)
    expect((await liveOption(theirs.id, theirMild.id)).is86d).toBe(false)
    expect(await currentSnapshot(mine.id)).toBeUndefined()
    expect(await currentSnapshot(theirs.id)).toBeUndefined()
  })

  it('refuses a session whose org maps to a different restaurant, and an unauthenticated one', async () => {
    const mine = await restaurant()
    const theirs = await restaurant()

    signedInAs(theirs.clerkOrgId)
    const forbidden = await call('POST', mine.slug, { itemId: mine.items[0].id, until: 'tomorrow' })
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json()).error).toBe('forbidden')

    signedInAs(null, null)
    expect((await call('POST', mine.slug, { itemId: mine.items[0].id, until: 'tomorrow' })).status).toBe(401)

    // Refused before anything is written, both times.
    expect((await liveItem(mine.id, mine.items[0].id)).is86d).toBe(false)
  })

  it('refuses a body that names no target, both targets, or a snooze it cannot read', async () => {
    const loc = await restaurant()
    signedInAs(loc.clerkOrgId)
    const item = loc.items[0].id

    // Neither: nothing to 86. Both: two dishes could be meant and the route must not
    // pick one.
    expect((await call('POST', loc.slug, { until: 'tomorrow' })).status).toBe(422)
    expect((await call('POST', loc.slug, {
      itemId: item, modifierOptionId: optionNamed(loc, 'Mild').id, until: 'tomorrow',
    })).status).toBe(422)
    expect((await call('POST', loc.slug, { itemId: item, until: 'someday' })).status).toBe(422)
    expect((await call('POST', loc.slug, { itemId: item })).status).toBe(422)
    // Not a uuid: shape-checked before it reaches a query, because 22P02 poisons the
    // whole transaction — the same rule `createOrder` follows for every id in a body.
    expect((await call('POST', loc.slug, { itemId: 'butter-chicken', until: 'tomorrow' })).status).toBe(422)
    expect((await call('POST', loc.slug, 'not json')).status).toBe(400)
    // No location at all is answered before the session is consulted.
    expect((await call('POST', null, { itemId: item, until: 'tomorrow' })).status).toBe(400)

    expect((await liveItem(loc.id, item)).is86d).toBe(false)
  })
})

describe('DELETE /api/menu/86', () => {
  it('puts the dish back, clears the snooze, and pins that too', async () => {
    const loc = await restaurant()
    signedInAs(loc.clerkOrgId)
    const eightySixed = await (await call('POST', loc.slug, { itemId: loc.items[0].id, until: 'tomorrow' })).json()
    await expect(placeOrder(loc)).rejects.toBeInstanceOf(ItemUnavailableError)

    const res = await call('DELETE', loc.slug, { itemId: loc.items[0].id })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.is86d).toBe(false)
    expect(body.unsnoozeAt).toBeNull()
    expect(body.snapshot.version).toBe(eightySixed.snapshot.version + 1)

    await expect(placeOrder(loc)).resolves.toMatchObject({ status: 'NEW' })
    expect(pinnedItem((await currentSnapshot(loc.id))!, loc.items[0].id).is86d).toBe(false)

    // The snooze is cleared with the flag, so the hourly job has nothing left to find
    // and cannot rebuild a snapshot for a menu nobody changed.
    const live = await liveItem(loc.id, loc.items[0].id)
    expect(live.is86d).toBe(false)
    expect(live.unsnoozeAt).toBeNull()
  })

  it('puts a topping back', async () => {
    const loc = await restaurant()
    const mild = optionNamed(loc, 'Mild')
    signedInAs(loc.clerkOrgId)
    await call('POST', loc.slug, { modifierOptionId: mild.id, until: 'manual' })
    await expect(placeOrder(loc, [mild.id])).rejects.toBeInstanceOf(OptionUnavailableError)

    expect((await call('DELETE', loc.slug, { modifierOptionId: mild.id })).status).toBe(200)

    await expect(placeOrder(loc, [mild.id])).resolves.toMatchObject({ status: 'NEW' })
    const live = await liveOption(loc.id, mild.id)
    expect(live.is86d).toBe(false)
    expect(live.unsnoozeAt).toBeNull()
  })

  it('cannot un-86 another restaurant\'s dish', async () => {
    const mine = await restaurant()
    const theirs = await restaurant()
    signedInAs(theirs.clerkOrgId)
    await call('POST', theirs.slug, { itemId: theirs.items[0].id, until: 'manual' })

    signedInAs(mine.clerkOrgId)
    expect((await call('DELETE', mine.slug, { itemId: theirs.items[0].id })).status).toBe(404)

    // Still sold out where it belongs — a cross-tenant un-86 is a dish back on sale
    // that a kitchen has none of.
    expect((await liveItem(theirs.id, theirs.items[0].id)).is86d).toBe(true)
  })
})

/** One historical snapshot, by version — snapshots are insert-only, so old ones stay readable. */
function snapshotVersion(locationId: string, version: number): Promise<MenuSnapshot | undefined> {
  return withLocation(locationId, async (tx) => {
    const [row] = await tx.select().from(menuSnapshots)
      .where(eq(menuSnapshots.version, version))
      .limit(1)
    return row
  })
}
