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
 * The most a single order may be tipped: **$2,000.00**.
 *
 * `tipCents` is the one money value on the whole write path that the client supplies
 * rather than the menu, so it is the one that needs a ceiling. Without one,
 * `Number.isSafeInteger` happily accepts 9007199254740991: that total is handed to
 * Stripe verbatim as the PaymentIntent amount, which refuses it **after** the order
 * row is committed — leaving a row stuck at PENDING_PAYMENT and a 500 — and on the
 * pay-at-pickup path it simply prints a ticket with a nonsense total.
 *
 * **An absolute cap in cents, not a percentage of the order.** `assertInputShape`
 * runs before a connection is opened, deliberately (a malformed id inside the
 * transaction is a 22P02 that poisons it), so it cannot see the subtotal and has no
 * basis for a relative bound. The number therefore has to be one that cannot refuse a
 * real tip on any order this product can plausibly take.
 *
 * $2,000 is that number. Pickup only, from an independent restaurant: the largest
 * genuine order is a catering run, and this still clears a 25% tip on an $8,000 one.
 * It is also three orders of magnitude below Stripe's own $999,999.99 per-charge
 * ceiling, so the cap that bites first is always ours, with a coded rejection a
 * customer can read — rather than Stripe's, after the money path has already started.
 * Above this is a typo or an attack, not generosity; a customer who genuinely wants
 * to tip more is a phone call, the same ruling `MAX_QTY_PER_STEPPER` makes.
 */
export const MAX_TIP_CENTS = 200_000

/**
 * How many **open pay-at-pickup orders one phone number may have at one restaurant
 * in one day**: ten.
 *
 * The one number in this file that is a business rule rather than a sanity bound, and
 * it is here because it belongs with the others a cart has to know about — the reason
 * this module exists is that a limit the client cannot see is a limit a customer meets
 * at the last step.
 *
 * **Why the cap exists at all.** Pay-at-pickup takes no money, asks for no account and
 * needs nothing but a phone number somebody typed. That is deliberate — it is what
 * lets a restaurant with no Stripe onboarding trade, and it is where a card order
 * lands when Stripe is down. It also means the only thing standing between a bored
 * stranger and a kitchen cooking forty dinners nobody collects is this number. The
 * cost of that is ingredients and a cook's evening, which no chargeback process gives
 * back.
 *
 * **Why ten, and why per day.** A big family order is one order. An office lunch run
 * is one order. Ten *separate, still-open* orders on one number before anybody has
 * collected anything is already past what a real evening looks like, so the customer
 * this turns away is one who should be phoning the restaurant instead — which is what
 * the rejection tells them to do. Counting only the **open** ones is what keeps a
 * regular who collects every order from being locked out by their own history, and
 * the day rolls at **local midnight at the restaurant**: on UTC, a New York kitchen's
 * cap would reset at 8pm, in the middle of service.
 */
export const MAX_OPEN_UNPAID_ORDERS_PER_PHONE_PER_DAY = 10

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
