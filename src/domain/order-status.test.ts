import { describe, it, expect } from 'vitest'
import { canTransition, transition, IllegalTransitionError } from './order-status'
import type { OrderStatus } from './order-status'

const legal: Array<[string, string]> = [
  ['PENDING_PAYMENT', 'NEW'], ['PENDING_PAYMENT', 'CANCELED'],
  ['NEW', 'ACCEPTED'], ['NEW', 'REJECTED'], ['NEW', 'CANCELED'],
  ['ACCEPTED', 'IN_KITCHEN'], ['ACCEPTED', 'READY'], ['ACCEPTED', 'CANCELED'],
  ['IN_KITCHEN', 'READY'], ['IN_KITCHEN', 'CANCELED'],
  ['READY', 'COMPLETED'], ['READY', 'CANCELED'],
]
const illegal: Array<[string, string]> = [
  ['COMPLETED', 'CANCELED'], ['REJECTED', 'NEW'], ['CANCELED', 'NEW'],
  ['NEW', 'READY'], ['NEW', 'COMPLETED'], ['PENDING_PAYMENT', 'ACCEPTED'],
]

describe('order status machine', () => {
  it.each(legal)('%s → %s is legal', (a, b) => expect(canTransition(a as any, b as any)).toBe(true))
  it.each(illegal)('%s → %s is illegal', (a, b) => expect(canTransition(a as any, b as any)).toBe(false))
})

// Written out rather than imported from the module: a matrix that enumerates the
// implementation's own list of statuses would shrink silently the day someone drops
// one, and prove nothing.
const ALL_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT', 'NEW', 'ACCEPTED', 'IN_KITCHEN', 'READY', 'COMPLETED', 'REJECTED', 'CANCELED',
]
const TERMINAL: OrderStatus[] = ['COMPLETED', 'REJECTED', 'CANCELED']
const isLegal = (from: string, to: string) => legal.some(([a, b]) => a === from && b === to)

describe('order status machine — the whole matrix', () => {
  // The 12 pairs above are the complete legal set, not a sample. This closes the
  // other 52: an edge nobody wrote down (IN_KITCHEN → COMPLETED, say, which skips
  // the customer ever being told the food is ready) must not quietly become legal.
  const pairs = ALL_STATUSES.flatMap((from) => ALL_STATUSES.map((to) => [from, to] as const))
  it.each(pairs)('%s → %s matches the documented edge set', (from, to) => {
    expect(canTransition(from, to)).toBe(isLegal(from, to))
  })

  it('allows CANCELED from every non-terminal state', () => {
    const cancelable = ALL_STATUSES.filter((s) => !TERMINAL.includes(s))
    expect(cancelable.filter((s) => canTransition(s, 'CANCELED'))).toEqual(cancelable)
  })

  it('lets nothing out of a terminal state', () => {
    const escapes = TERMINAL.flatMap((from) => ALL_STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}→${to}`))
    expect(escapes).toEqual([])
  })

  it('refuses a status to itself, so a double-tap cannot append a second event', () => {
    expect(ALL_STATUSES.filter((s) => canTransition(s, s))).toEqual([])
  })

  it('answers false for a status it does not know instead of throwing', () => {
    // A row read back with a status from a newer deploy must fail closed, not crash
    // the feed. Only `canTransition` is defensive; `transition` still throws.
    expect(canTransition('SHIPPED' as OrderStatus, 'NEW')).toBe(false)
    expect(canTransition('NEW', 'SHIPPED' as OrderStatus)).toBe(false)
  })
})

describe('transition', () => {
  it('returns the next status and the event row to append', () => {
    const result = transition({ status: 'NEW' }, 'ACCEPTED', 'user_2abc')
    expect(result).toEqual({
      next: 'ACCEPTED',
      event: { type: 'status_changed', actor: 'user_2abc', payload: { from: 'NEW', to: 'ACCEPTED' } },
    })
  })

  it('records the status it came from, not the one it is going to', () => {
    const { event } = transition({ status: 'IN_KITCHEN' }, 'READY', 'system')
    expect(event.payload).toEqual({ from: 'IN_KITCHEN', to: 'READY' })
  })

  it('takes a whole order row, not just a status', () => {
    const order = { id: 'ord_1', status: 'READY' as const, totalCents: 4850, shortCode: 'K7M2' }
    expect(transition(order, 'COMPLETED', 'user_2abc').next).toBe('COMPLETED')
  })

  it('throws IllegalTransitionError on an edge the machine does not have', () => {
    expect(() => transition({ status: 'COMPLETED' }, 'CANCELED', 'user_2abc')).toThrow(IllegalTransitionError)
  })

  it('names both ends of the refused edge, in the error and on the error', () => {
    try {
      transition({ status: 'CANCELED' }, 'NEW', 'system')
      expect.unreachable('transition should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError)
      const e = err as IllegalTransitionError
      expect(e.name).toBe('IllegalTransitionError')
      expect(e.from).toBe('CANCELED')
      expect(e.to).toBe('NEW')
      expect(e.message).toContain('CANCELED')
      expect(e.message).toContain('NEW')
    }
  })

  it('writes no event when it refuses — nothing partial escapes', () => {
    // The event only exists inside the returned object, so a refusal cannot leave a
    // half-made row behind. Guards the shape of the contract, not the callers.
    let result: unknown = 'untouched'
    try {
      result = transition({ status: 'REJECTED' }, 'ACCEPTED', 'system')
    } catch {
      /* expected */
    }
    expect(result).toBe('untouched')
  })
})
