import { describe, it, expect } from 'vitest'

/**
 * The serve route is four lines and no logic, so this is a smoke test with one job:
 * prove the fan-out is actually *registered*. A function that exists but is not in
 * the `functions` array is silently never invoked — the events are accepted, the
 * dashboard shows nothing, and the first symptom is a kitchen that stopped printing.
 *
 * It is also the only place the `inngest/next` serve helper is exercised against this
 * Next version at all, which is worth one import on its own.
 */
describe('/api/inngest', () => {
  it('exports the three App Router handlers Inngest needs', async () => {
    const route = await import('./inngest/route')
    // GET introspects, POST invokes, PUT registers. Missing any one of them is a
    // deploy that looks healthy and never runs a function.
    expect(typeof route.GET).toBe('function')
    expect(typeof route.POST).toBe('function')
    expect(typeof route.PUT).toBe('function')
  })

  it('triggers the fan-out on the event the webhook sends', async () => {
    const { ORDER_CREATED } = await import('@/inngest/client')
    const { orderCreated } = await import('@/inngest/order-created')

    expect(orderCreated.id()).toContain('order-created')
    // Read off the function's own options rather than restated from the source: a
    // typo'd event name compiles, serves, and is delivered nothing, forever. Pinned
    // against the constant the sender uses, so the two cannot drift apart.
    expect(orderCreated.opts.triggers).toEqual([{ event: ORDER_CREATED }])
  })

  it('serves every function in the registry, the hourly unsnooze included', async () => {
    const { functions } = await import('@/inngest/functions')
    const { unsnooze, UNSNOOZE_CRON } = await import('@/inngest/unsnooze')

    // A cron that is defined but not registered is the worst version of this bug:
    // there is no event to go missing and no failed run to look at, so the only
    // symptom is dishes that stay 86'd and an owner who stops trusting the button.
    expect(functions.map((fn) => fn.id(''))).toContain(unsnooze.id(''))
    expect(unsnooze.opts.triggers).toEqual([{ cron: UNSNOOZE_CRON }])
  })

  it('serves the whole registry, by name, so a new function cannot be half-added', async () => {
    const { functions } = await import('@/inngest/functions')

    // **The exact set, not a `toContain`.** Every alarm in this system is a function
    // whose absence looks exactly like nothing being wrong: an unregistered cron has
    // no event to go missing and no failed run to look at, and an unregistered event
    // listener is an event Inngest accepts and drops. Pinning the list means adding
    // one is two edits and forgetting the second is a failing test rather than a
    // silence somebody notices in six weeks.
    expect(functions.map((fn) => fn.id('')).sort()).toEqual([
      'order-created-fan-out',
      'printer-heartbeat',
      'provenance-refused-alert',
      'stale-order-alert',
      'stripe-outage-alert',
      'synthetic-canary-order',
      'unsnooze-expired-86s',
    ])
  })

  it('escalates a stale order off the same event the fan-out rides', async () => {
    const { ORDER_CREATED } = await import('@/inngest/client')
    const { staleOrderAlert } = await import('@/inngest/stale-order-alert')

    // Two functions, one event, on purpose: both paths to NEW already send exactly
    // one, and a second event would be a second thing to remember to fire — from the
    // path that was only just fixed.
    expect(staleOrderAlert.opts.triggers).toEqual([{ event: ORDER_CREATED }])
  })

  it('runs the printer heartbeat on its cron and the provenance alarm on its event', async () => {
    const { PROVENANCE_REFUSED } = await import('@/inngest/client')
    const { printerHeartbeat, HEARTBEAT_CRON } = await import('@/inngest/printer-heartbeat')
    const { provenanceRefused } = await import('@/inngest/provenance-refused')

    expect(printerHeartbeat.opts.triggers).toEqual([{ cron: HEARTBEAT_CRON }])
    expect(provenanceRefused.opts.triggers).toEqual([{ event: PROVENANCE_REFUSED }])
  })

  it('runs the canary on its schedule and the Stripe-outage alarm on the event the route sends', async () => {
    const { STRIPE_OUTAGE } = await import('@/inngest/client')
    const { canary, CANARY_SCHEDULE } = await import('@/inngest/canary')
    const { stripeOutageAlert } = await import('@/inngest/stripe-outage-alert')

    expect(canary.opts.triggers).toEqual([{ cron: CANARY_SCHEDULE }])
    expect(stripeOutageAlert.opts.triggers).toEqual([{ event: STRIPE_OUTAGE }])
  })
})
