/**
 * The bounds an order is built inside — **one copy, imported by both ends**.
 *
 * These numbers were in three places until Task 3: `create-order.ts` held them as
 * module-private consts, `cart-provider.tsx` restated them, and `browse.tsx` wrote
 * the note cap out again as `NOTES_MAX`. Nothing kept the copies equal, and the
 * failure mode is quiet and expensive in both directions — a cart that lets a
 * customer build an order the server refuses wastes their time at the last step, and
 * a cart tighter than the server is a dish nobody can order for a reason no page
 * explains.
 *
 * It is a plain constants module with **no imports**, and that is deliberate: the
 * client needs these numbers and must not reach `create-order.ts` for them, which
 * pulls in the database, the repos and the whole server half of the app.
 *
 * They are sanity bounds, not business rules. Nobody is turning away a real order at
 * these numbers; they are here because both are arithmetic and resource limits.
 */

/**
 * `unitPrice × qty` leaves exact integer range long before `qty` stops being a legal
 * integer. Bounded here, an absurd quantity comes back as a named rejection instead
 * of a 500.
 */
export const MAX_QTY_PER_LINE = 999

/**
 * `insertOrder` writes one statement per line inside the transaction, so a
 * ten-thousand-line request would hold it open while it ran.
 */
export const MAX_LINES_PER_ORDER = 100

/**
 * Length cap for the free-text fields the client controls — `contact.email` and a
 * line's `notes`. Nobody's email or special-instruction text is legitimately this
 * long, so it turns a wildly oversized string into a named rejection. Generous and
 * arbitrary; there was no existing length cap to stay consistent with.
 */
export const MAX_TEXT_FIELD_LENGTH = 500

/**
 * What one tap-tap-tap of a stepper may reach — the **UI's** own, narrower cap, and
 * the one number here the server does not enforce.
 *
 * A stepper is for "make it three", and a customer who wants a hundred samosas is a
 * phone call, not a thumb. It lives beside the order bounds because "how many of one
 * dish" is one question with two answers, and the pair only reads correctly together:
 * this one must never be the larger. The cart still accepts what the server does, so
 * nothing here narrows what an order may contain.
 */
export const MAX_QTY_PER_STEPPER = 99
