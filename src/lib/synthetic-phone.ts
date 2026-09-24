/**
 * **A different fictional customer every time**, in the 555 area code, which the NANP
 * never assigns — so it is E.164-shaped (`createOrder` insists) and cannot ring anyone.
 *
 * For the two things that place orders nobody real placed: the spine proof
 * (`npm run spine:proof`) and the synthetic canary (`src/inngest/canary.ts`). Both used
 * to be one fixed number, and the unpaid-order cap is what makes that wrong: the cap is
 * ten *open* pay-at-pickup orders per phone per location per day, so an order that is
 * left open — the proof leaves every one open, and a canary run whose clean-up failed
 * leaves one — counts, and the eleventh run of the day on one number is refused
 * `unpaid_order_cap`: the check failing for the one reason that is not a bug. They are
 * separate fake customers, so they get separate fake numbers.
 *
 * The last seven digits of the clock in milliseconds: distinct for anything run a
 * millisecond apart. The sequence wraps every 2.8 hours, and that is fine — what matters
 * is that one day's *open* orders do not share a number, not that no number ever recurs.
 */
export function syntheticPhone(): string {
  return `+1555${String(Date.now()).slice(-7)}`
}
