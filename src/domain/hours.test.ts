import { describe, it, expect } from 'vitest'
import { isOpenAt } from './hours'
import { businessHours, holidayClosures, orderPauses } from '@/db/schema'
import { seedLocation } from '@/test/seed'
import { withLocation } from '@/repo/scoped'
import { errorChainText } from '@/test/errors'

// business_hours, holiday_closures and order_pauses went under RLS in 0009 — one
// restaurant inserting an order_pause against another is a revenue denial-of-service,
// not a privacy question. So every write here is scoped, and `isOpenAt` scopes its
// own reads. A bare db() write is refused (42501), not silently misfiled.

// Every instant is written as its UTC equivalent, never as a local-looking string:
// `new Date('2026-09-22T18:00')` would mean 18:00 on whatever machine ran the test,
// and the suite would pass in New York and lie everywhere else.
//
// America/New_York is UTC-4 in September (EDT) and UTC-5 in January (EST).
const TUE_16_00_ET = new Date('2026-09-22T20:00:00Z') // inside the lunch/dinner gap
const TUE_17_00_ET = new Date('2026-09-22T21:00:00Z') // exactly openTime
const TUE_18_00_ET = new Date('2026-09-22T22:00:00Z') // mid-dinner
const TUE_21_59_ET = new Date('2026-09-23T01:59:00Z') // a minute before close
const TUE_22_00_ET = new Date('2026-09-23T02:00:00Z') // exactly closeTime
const TUE_23_30_ET = new Date('2026-09-23T03:30:00Z') // late night, past 22:00
const WED_01_00_ET = new Date('2026-09-23T05:00:00Z') // the other side of midnight
// Same 21:00 UTC as TUE_17_00_ET, but in standard time it is 16:00 local, not 17:00.
const TUE_16_00_EST = new Date('2027-01-19T21:00:00Z')

/** Tue (dow 2) split service: lunch 11:30–15:00, dinner 17:00–22:00. */
async function seedTuesdaySplitService(locationId: string) {
  await withLocation(locationId, (tx) => tx.insert(businessHours).values([
    { locationId, dow: 2, openTime: '11:30:00', closeTime: '15:00:00' },
    { locationId, dow: 2, openTime: '17:00:00', closeTime: '22:00:00' },
  ]))
}

describe('isOpenAt', () => {
  it('is closed between the lunch and dinner services', async () => {
    const loc = await seedLocation()
    await seedTuesdaySplitService(loc.id)
    expect(await isOpenAt(loc.id, TUE_16_00_ET)).toEqual({ open: false, reason: 'closed_hours' })
  })

  it('is open inside the dinner service', async () => {
    const loc = await seedLocation()
    await seedTuesdaySplitService(loc.id)
    expect(await isOpenAt(loc.id, TUE_18_00_ET)).toEqual({ open: true })
  })

  it('is paused while an order pause is live, even mid-service', async () => {
    const loc = await seedLocation()
    await seedTuesdaySplitService(loc.id)
    await withLocation(loc.id, (tx) => tx.insert(orderPauses).values({
        locationId: loc.id,
        until: new Date(TUE_18_00_ET.getTime() + 60 * 60_000),
        reason: 'slammed',
        createdBy: 'user_owner',  }))
    expect(await isOpenAt(loc.id, TUE_18_00_ET)).toEqual({ open: false, reason: 'paused' })
  })

  it('reopens once the pause has expired', async () => {
    const loc = await seedLocation()
    await seedTuesdaySplitService(loc.id)
    // Auto-resume is the whole point of `until`: a stale row must not keep a
    // location dark forever.
    await withLocation(loc.id, (tx) => tx.insert(orderPauses).values({
        locationId: loc.id,
        until: new Date(TUE_18_00_ET.getTime() - 60_000),
        reason: 'slammed',  }))
    expect(await isOpenAt(loc.id, TUE_18_00_ET)).toEqual({ open: true })
  })

  it('treats openTime as inclusive and closeTime as exclusive', async () => {
    const loc = await seedLocation()
    await seedTuesdaySplitService(loc.id)
    expect(await isOpenAt(loc.id, TUE_17_00_ET)).toEqual({ open: true })
    expect(await isOpenAt(loc.id, TUE_21_59_ET)).toEqual({ open: true })
    // The last order must not land on the stroke of close.
    expect(await isOpenAt(loc.id, TUE_22_00_ET)).toEqual({ open: false, reason: 'closed_hours' })
  })

  it('is closed for a holiday that falls inside posted hours', async () => {
    const loc = await seedLocation()
    await seedTuesdaySplitService(loc.id)
    await withLocation(loc.id, (tx) => tx.insert(holidayClosures).values({
        locationId: loc.id,
        startsAt: new Date('2026-09-22T04:00:00Z'), // local midnight
        endsAt: new Date('2026-09-23T04:00:00Z'),
        reason: 'Staff party',  }))
    expect(await isOpenAt(loc.id, TUE_18_00_ET)).toEqual({ open: false, reason: 'holiday' })
  })

  it('ends a closure exclusively, so the next service opens on time', async () => {
    const loc = await seedLocation()
    await seedTuesdaySplitService(loc.id)
    await withLocation(loc.id, (tx) => tx.insert(holidayClosures).values({
        locationId: loc.id,
        startsAt: new Date('2026-09-22T04:00:00Z'),
        endsAt: TUE_17_00_ET, // reopening for dinner
        reason: 'Morning deep clean',  }))
    expect(await isOpenAt(loc.id, TUE_16_00_ET)).toEqual({ open: false, reason: 'holiday' })
    expect(await isOpenAt(loc.id, TUE_17_00_ET)).toEqual({ open: true })
  })

  it('reports paused over holiday over closed_hours when all three apply', async () => {
    const loc = await seedLocation()
    await seedTuesdaySplitService(loc.id)
    await withLocation(loc.id, (tx) => tx.insert(holidayClosures).values({
        locationId: loc.id,
        startsAt: new Date('2026-09-22T04:00:00Z'),
        endsAt: new Date('2026-09-23T04:00:00Z'),
        reason: 'Staff party',  }))
    // TUE_16_00_ET is already outside hours and already inside the closure.
    expect(await isOpenAt(loc.id, TUE_16_00_ET)).toEqual({ open: false, reason: 'holiday' })

    await withLocation(loc.id, (tx) => tx.insert(orderPauses).values({
        locationId: loc.id,
        until: new Date(TUE_16_00_ET.getTime() + 60 * 60_000),
        reason: 'slammed',  }))
    expect(await isOpenAt(loc.id, TUE_16_00_ET)).toEqual({ open: false, reason: 'paused' })
  })

  it('answers in the location timezone, not the server timezone', async () => {
    const ny = await seedLocation({ timezone: 'America/New_York' })
    const tokyo = await seedLocation({ timezone: 'Asia/Tokyo' })
    await seedTuesdaySplitService(ny.id)
    await seedTuesdaySplitService(tokyo.id)
    // One instant: Tuesday 18:00 in New York is already Wednesday 07:00 in Tokyo,
    // and nothing is posted for Wednesday.
    expect(await isOpenAt(ny.id, TUE_18_00_ET)).toEqual({ open: true })
    expect(await isOpenAt(tokyo.id, TUE_18_00_ET)).toEqual({ open: false, reason: 'closed_hours' })
  })

  it('follows daylight saving rather than a fixed offset', async () => {
    const loc = await seedLocation()
    await seedTuesdaySplitService(loc.id)
    // Identical 21:00 UTC clock time on two Tuesdays: 17:00 local in EDT (open),
    // 16:00 local in EST (the gap). A hardcoded -4 would call both open.
    expect(await isOpenAt(loc.id, TUE_17_00_ET)).toEqual({ open: true })
    expect(await isOpenAt(loc.id, TUE_16_00_EST)).toEqual({ open: false, reason: 'closed_hours' })
  })

  it('serves past midnight when the shift is stored as two rows', async () => {
    const loc = await seedLocation()
    // The documented way to post a 17:00–02:00 shift: it must not wrap within a row.
    await withLocation(loc.id, (tx) => tx.insert(businessHours).values([
      { locationId: loc.id, dow: 2, openTime: '17:00:00', closeTime: '24:00:00' },
      { locationId: loc.id, dow: 3, openTime: '00:00:00', closeTime: '02:00:00' },
    ]))
    expect(await isOpenAt(loc.id, TUE_23_30_ET)).toEqual({ open: true })
    expect(await isOpenAt(loc.id, WED_01_00_ET)).toEqual({ open: true })
  })

  it('scopes hours and pauses to the location', async () => {
    const paused = await seedLocation()
    const busy = await seedLocation()
    await seedTuesdaySplitService(paused.id)
    await seedTuesdaySplitService(busy.id)
    await withLocation(paused.id, (tx) => tx.insert(orderPauses).values({
        locationId: paused.id,
        until: new Date(TUE_18_00_ET.getTime() + 60 * 60_000),
        reason: 'slammed',  }))
    // One restaurant hitting pause must never close the one next door.
    expect(await isOpenAt(paused.id, TUE_18_00_ET)).toEqual({ open: false, reason: 'paused' })
    expect(await isOpenAt(busy.id, TUE_18_00_ET)).toEqual({ open: true })
  })

  it('refuses a row that wraps past midnight, and accepts the same shift split in two', async () => {
    const loc = await seedLocation()
    // `22:00 <= t AND t < 02:00` is satisfiable by no instant at all: the row would
    // post a dinner service and close the restaurant for the entire day instead,
    // silently. The database has to be the one that says no — this is data entry,
    // not arithmetic, so no amount of care in isOpenAt can prevent it.
    const err = await withLocation(loc.id, (tx) => tx.insert(businessHours)
      .values({ locationId: loc.id, dow: 2, openTime: '22:00:00', closeTime: '02:00:00' }))
      .then(() => null, (e: unknown) => e)
    expect(err).not.toBeNull()
    expect(errorChainText(err)).toMatch(/business_hours_no_midnight_wrap/)

    // The documented alternative must stay legal, 24:00:00 boundary included.
    await expect(withLocation(loc.id, (tx) => tx.insert(businessHours).values([
      { locationId: loc.id, dow: 2, openTime: '22:00:00', closeTime: '24:00:00' },
      { locationId: loc.id, dow: 3, openTime: '00:00:00', closeTime: '02:00:00' },
    ]))).resolves.toBeDefined()
  })

  it('is closed when no hours are posted at all', async () => {
    const loc = await seedLocation()
    expect(await isOpenAt(loc.id, TUE_18_00_ET)).toEqual({ open: false, reason: 'closed_hours' })
  })

  it('refuses to guess for an unknown location', async () => {
    await expect(isOpenAt('00000000-0000-0000-0000-000000000000', TUE_18_00_ET))
      .rejects.toThrow(/unknown location/i)
  })
})
