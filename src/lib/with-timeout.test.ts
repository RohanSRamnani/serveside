import { describe, it, expect, afterEach, vi } from 'vitest'
import { withTimeout, TimeoutError } from './with-timeout'

/**
 * The bound on a call we cannot afford to wait on. Pure, so it runs on fake timers:
 * the whole point is what happens when the clock wins, and a real five-second wait
 * would make the suite pay for it on every run.
 */
afterEach(() => {
  vi.useRealTimers()
})

describe('withTimeout', () => {
  it('hands back the value when the call answers in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 5_000, 'fast call')).resolves.toBe('ok')
  })

  it('passes the call’s own failure through untouched', async () => {
    await expect(withTimeout(Promise.reject(new Error('refused')), 5_000, 'call')).rejects.toThrow('refused')
  })

  it('gives up on a call that never answers, naming it and the bound', async () => {
    vi.useFakeTimers()
    const hung = withTimeout(new Promise<never>(() => {}), 5_000, 'inngest.send(order/created)')
    const settled = expect(hung).rejects.toThrow('inngest.send(order/created) did not settle within 5000ms')

    await vi.advanceTimersByTimeAsync(4_999)
    await vi.advanceTimersByTimeAsync(1)
    await settled
    await expect(hung).rejects.toBeInstanceOf(TimeoutError)
  })

  it('does not fire early', async () => {
    vi.useFakeTimers()
    let done = false
    void withTimeout(new Promise<never>(() => {}), 5_000, 'call').catch(() => { done = true })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it('leaves no timer behind once the call has answered', async () => {
    // A pending five-second timer per request would hold a serverless function open
    // after its response for nothing.
    vi.useFakeTimers()
    await withTimeout(Promise.resolve(1), 5_000, 'call')
    expect(vi.getTimerCount()).toBe(0)
  })
})
