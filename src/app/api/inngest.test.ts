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
})
