/**
 * The bound on a call we cannot afford to wait on.
 *
 * Some calls happen *after* the thing that matters has already happened — an Inngest
 * send after an order has committed is the case this exists for. Waiting on one with no
 * limit hands the outcome to the platform's function timeout, which kills the request
 * mid-wait and turns "the order is placed, the kitchen will hear about it late" into
 * "the customer was told nothing happened". Bounded, a hang becomes an ordinary thrown
 * failure that the caller's existing `catch` already knows what to do with.
 *
 * **It does not cancel the call.** A promise cannot be cancelled; the losing call keeps
 * running (or hanging) in the background and whatever it eventually does is ignored.
 * `Promise.race` has attached a handler to it, so a late rejection is not an unhandled
 * one. The timer is cleared the moment either side settles, so a call that answers in
 * time leaves nothing pending behind it.
 */
export class TimeoutError extends Error {
  readonly ms: number

  constructor(label: string, ms: number) {
    super(`${label} did not settle within ${ms}ms`)
    this.name = 'TimeoutError'
    this.ms = ms
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
