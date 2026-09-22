/**
 * Flattens a driver error into text a test can match a constraint name against.
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError` whose own message is only the
 * failed query, so the constraint name lives further down `cause` — and on the
 * `constraint` field rather than in any message.
 */
export function errorChainText(err: unknown): string {
  let text = ''
  for (let e: unknown = err, depth = 0; e != null && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    text += `${(e as Error).message ?? ''} ${(e as { constraint?: string }).constraint ?? ''}\n`
  }
  return text
}

/** Runs `fn`, expecting it to reject, and returns the flattened error text. */
export async function rejectionText(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    return errorChainText(err)
  }
  throw new Error('expected the statement to be rejected, but it succeeded')
}
