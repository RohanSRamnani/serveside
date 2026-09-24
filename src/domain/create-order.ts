import { and, count, eq, gte, inArray, notInArray, sql } from 'drizzle-orm'
import {
  locations, menus, menuItems, modifierOptions, orderEvents, orders,
  paymentStatus as paymentStatusEnum,
} from '@/db/schema'
import type { OrderEventPayload } from '@/db/schema'
import { withLocation, isUuid, type ScopedTx } from '@/repo/scoped'
import { ordersRepo, type NewOrderLine } from '@/repo/orders-repo'
import { isOpenAt, startOfLocalDay, type ClosedReason } from './hours'
import { getOrBuildCurrentSnapshot } from './snapshot'
import type { OrderStatus } from './order-status'
import {
  taxCentsFor, unitPriceCentsFor, lineTotalCentsFor, totalCentsFor, assertTotalsBalance, type Totals,
} from '@/lib/money'
import {
  MAX_LINES_PER_ORDER, MAX_OPEN_UNPAID_ORDERS_PER_PHONE_PER_DAY, MAX_QTY_PER_LINE,
  MAX_TEXT_FIELD_LENGTH, MAX_TIP_CENTS,
} from '@/lib/order-limits'
import { makeShortCode } from '@/lib/short-code'

/**
 * Placing an order. If everything else in this product is broken, this must still
 * work, and the money must still be right.
 *
 * Three things make it trustworthy, and none of them may be relaxed:
 *
 * 1. **The client is not consulted about anything that costs money.** Prices, price
 *    deltas, 86 flags and modifier limits are read from the database inside the same
 *    transaction that writes the order. The input carries ids and quantities; every
 *    number on the receipt comes from the menu.
 * 2. **One transaction, all or nothing.** Snapshot, order, lines, modifiers and the
 *    `created` event are written inside a single `withLocation` scope. There is no
 *    state in which a kitchen has a ticket for an order that does not exist, or an
 *    order exists with no lines.
 * 3. **It trusts its `locationId`.** `withLocation` is scoping, not authorization —
 *    it decides which rows are visible, not who is allowed to ask. Whoever calls
 *    this has already established that the caller may order from that restaurant.
 */
export type CreateOrderInput = {
  locationId: string
  channel: 'web' | 'voice' | 'sms'
  /** Pickup only for now; the delivery fee below is hardcoded 0 because of it. */
  fulfillment: 'pickup'
  contact: { name: string; phone: string; email?: string }
  /**
   * `modifierOptionIds` is optional and defaults to `[]`: a line with no modifiers is
   * the most ordinary thing on a menu, and making the client send an empty array for
   * it turns the commonest cart into a validation error.
   */
  items: Array<{ menuItemId: string; qty: number; modifierOptionIds?: string[]; notes?: string }>
  tipCents: number
  payment: 'card' | 'pay_on_pickup'
  /**
   * **TCPA marketing opt-in, and only ever `true` because a customer ticked a box.**
   *
   * Optional and defaulting to false: the voice and SMS agents predate this field and
   * will keep posting without it, and for consent "absent" must mean "did not
   * consent" rather than "unknown". `assertInputShape` refuses anything that is not a
   * boolean — including the string `'false'`, which is truthy and is exactly what a
   * careless form serialiser produces.
   *
   * Marketing only. The order's own messages are transactional and are never gated on
   * this.
   */
  smsMarketingConsent?: boolean
}

export type CreateOrderResult = {
  orderId: string
  shortCode: string
  totalCents: number
  status: OrderStatus
}

/** Taken from the column, as `OrderStatus` is, so the type and the enum cannot drift apart. */
type PaymentStatus = (typeof paymentStatusEnum.enumValues)[number]

/**
 * Every way an order can be turned down for a reason the customer could act on —
 * a sold-out dish, a closed kitchen, a missing spice choice.
 *
 * Deliberately a family with a `code`: the HTTP layer (Task 9) maps one base class
 * to 4xx and passes the code on, so a new rejection does not need a new route
 * branch. A bug in *our* arithmetic is not one of these — that throws a plain Error
 * and deserves a 500.
 */
export abstract class OrderRejectedError extends Error {
  abstract readonly code: string

  constructor(message: string) {
    super(message)
    // Each subclass reports its own name without restating it.
    this.name = new.target.name
  }
}

/** The request itself is malformed — no lines, a fractional quantity, a repeated modifier. */
export class InvalidOrderInputError extends OrderRejectedError {
  readonly code = 'invalid_input'
}

/** The restaurant is not trading at all: suspended, not yet launched, shut down. */
export class LocationInactiveError extends OrderRejectedError {
  readonly code = 'location_inactive'
  readonly status: string

  constructor(locationId: string, status: string) {
    super(`Location ${locationId} is not accepting orders (status: ${status})`)
    this.status = status
  }
}

/** Open for business, shut right now. `reason` is what the customer is told. */
export class LocationClosedError extends OrderRejectedError {
  readonly code = 'location_closed'
  readonly reason: ClosedReason

  constructor(locationId: string, reason: ClosedReason) {
    super(`Location ${locationId} is not taking orders right now (${reason})`)
    this.reason = reason
  }
}

/**
 * The location does not have exactly one active menu, so there is no defensible
 * answer to "what is on sale and for how much".
 *
 * A rejection rather than the plain `Error` `buildMenuSnapshot` raises for the same
 * two states, because this one is reachable from the public write path: an owner who
 * switches a menu off mid-service must get a closed door, not a 500 — and above all
 * not a sale priced off a menu nobody can pin.
 */
export class MenuUnavailableError extends OrderRejectedError {
  readonly code = 'menu_unavailable'
  readonly activeMenuCount: number

  constructor(locationId: string, activeMenuCount: number) {
    super(activeMenuCount === 0
      ? `Location ${locationId} has no active menu`
      : `Location ${locationId} has ${activeMenuCount} active menus; exactly one must be active to take orders`)
    this.activeMenuCount = activeMenuCount
  }
}

/** No such dish on this location's menu — including another restaurant's dish, which RLS hides. */
export class UnknownMenuItemError extends OrderRejectedError {
  readonly code = 'unknown_item'
  readonly menuItemId: string

  constructor(menuItemId: string) {
    super(`No menu item ${menuItemId} on this location's menu`)
    this.menuItemId = menuItemId
  }
}

/** The dish exists and is sold out. */
export class ItemUnavailableError extends OrderRejectedError {
  readonly code = 'item_unavailable'
  readonly menuItemId: string
  readonly itemName: string

  constructor(menuItemId: string, itemName: string) {
    super(`${itemName} is sold out`)
    this.menuItemId = menuItemId
    this.itemName = itemName
  }
}

/** The option does not exist here, or is not offered on the dish it was sent with. */
export class UnknownModifierOptionError extends OrderRejectedError {
  readonly code = 'unknown_option'
  readonly modifierOptionId: string
  readonly menuItemId: string

  constructor(modifierOptionId: string, menuItemId: string, itemName: string) {
    super(`Modifier option ${modifierOptionId} is not offered on ${itemName}`)
    this.modifierOptionId = modifierOptionId
    this.menuItemId = menuItemId
  }
}

/** The option exists on the dish and is sold out — 86 applies to toppings too. */
export class OptionUnavailableError extends OrderRejectedError {
  readonly code = 'option_unavailable'
  readonly modifierOptionId: string
  readonly optionName: string

  constructor(modifierOptionId: string, optionName: string) {
    super(`${optionName} is sold out`)
    this.modifierOptionId = modifierOptionId
    this.optionName = optionName
  }
}

/** Too few or too many choices in one modifier group, against that item's effective limits. */
export class ModifierSelectionError extends OrderRejectedError {
  readonly code = 'modifier_selection'
  readonly groupId: string
  readonly groupName: string
  readonly minSelect: number
  readonly maxSelect: number
  readonly chosen: number

  constructor(groupId: string, groupName: string, minSelect: number, maxSelect: number, chosen: number) {
    super(
      `${groupName} takes ${minSelect === maxSelect ? `exactly ${minSelect}` : `${minSelect} to ${maxSelect}`} `
      + `selection(s), got ${chosen}`,
    )
    this.groupId = groupId
    this.groupName = groupName
    this.minSelect = minSelect
    this.maxSelect = maxSelect
    this.chosen = chosen
  }
}

/**
 * This phone already has as many open pay-at-pickup orders as one number gets in a
 * day at this restaurant.
 *
 * The rejection a customer is most likely to meet without having done anything wrong,
 * so the message is the whole of the answer: it says how many, and it says what to do
 * instead. The number comes from the constant rather than the sentence, so the copy
 * cannot drift away from the rule it describes.
 */
export class UnpaidOrderCapError extends OrderRejectedError {
  readonly code = 'unpaid_order_cap'
  readonly openOrders: number

  constructor(openOrders: number) {
    super(
      `You already have ${MAX_OPEN_UNPAID_ORDERS_PER_PHONE_PER_DAY} unpaid pickup orders today — `
      + 'call the restaurant to place another.',
    )
    this.openOrders = openOrders
  }
}

/**
 * E.164, as the standard writes it: a `+`, a country code whose first digit is not 0,
 * and 7 to 15 digits in total.
 *
 * The lower bound is the one worth stating. `sendSms` uses `^\+[1-9]\d{1,14}$`, which
 * accepts `+12` — a legal *shape* and not a number anyone can be reached on. This is
 * the write path rather than the send path, so it is the place to be stricter: the
 * shortest real E.164 numbers in service are 7 digits, so `+` and at least 7 digits it
 * is. Anything shorter that reaches storage is a typo nobody can call back.
 */
const E164 = /^\+[1-9]\d{6,14}$/

/** Pickup only, so there is no fee to compute. Named rather than inlined as a bare 0. */
const PICKUP_DELIVERY_FEE_CENTS = 0
/** Discounts land with promotions; the column exists and is always 0 for now. */
const NO_DISCOUNT_CENTS = 0

// The three sanity bounds `assertInputShape` enforces — MAX_LINES_PER_ORDER,
// MAX_QTY_PER_LINE, MAX_TEXT_FIELD_LENGTH — live in `@/lib/order-limits`, with the
// argument for each number. They were module-private here and restated in the cart,
// which is the client's only way to stop a customer building an order this function
// would refuse; nothing kept the copies equal. That module has no imports of its own
// precisely so the browser can read the numbers without dragging the database in
// behind them.

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  assertInputShape(input)
  // One instant for the whole order: "are you open" and "when will it be ready"
  // must not be answered from two different clocks.
  const placedAt = new Date()

  return withLocation(input.locationId, async (tx) => {
    const location = await readLocation(tx, input.locationId)
    // Trading status first: a suspended restaurant can be open by the clock and
    // still must not take money.
    if (location.status !== 'active') throw new LocationInactiveError(input.locationId, location.status)

    // Inside the transaction and on our `tx`, so the hours the check reads are the
    // hours that hold while the order is written — and so it does not open a second
    // pooled connection of its own.
    const openState = await isOpenAt(input.locationId, placedAt, tx)
    // `reason` is always set when `open` is false; the fallback is for the type.
    if (!openState.open) throw new LocationClosedError(input.locationId, openState.reason ?? 'closed_hours')

    /**
     * **The unpaid-order cap**, and it applies to pay-at-pickup only — see
     * `MAX_OPEN_UNPAID_ORDERS_PER_PHONE_PER_DAY` for why the cap exists at all.
     *
     * Checked here rather than in `assertInputShape` because it is the one bound that
     * needs the database *and* the location's timezone. Being inside the transaction
     * that writes the order is necessary and **not sufficient**: under READ COMMITTED a
     * COUNT takes no lock, so a burst of simultaneous posts would all read nine and all
     * write. `assertUnderUnpaidCap` serialises them first — see the lock there.
     *
     * **A card order that failed over to pay-at-pickup is never re-checked.** That
     * conversion happens in `POST /api/orders` after this function has returned, when
     * Stripe could not be reached: the customer asked to pay now and the platform
     * could not take their money. Counting that against them would be charging them
     * for our outage — so the failover writes the order directly and does not come
     * back through here.
     */
    if (input.payment === 'pay_on_pickup') {
      await assertUnderUnpaidCap(tx, input.locationId, input.contact.phone, placedAt, location.timezone)
    }

    const lines = await priceLines(tx, input)
    const totals = totalsFor(lines, input.tipCents, location.taxRatePer100k)

    // Pinned, not rebuilt: see getOrBuildCurrentSnapshot. Same transaction as the
    // order, so `orders.menu_snapshot_id` can never name a row that was rolled back.
    const snapshot = await getOrBuildCurrentSnapshot(input.locationId, tx)

    const status: OrderStatus = input.payment === 'card' ? 'PENDING_PAYMENT' : 'NEW'
    const paymentStatus: PaymentStatus = input.payment === 'card' ? 'REQUIRES_PAYMENT' : 'PAY_ON_PICKUP'

    const values = {
      locationId: input.locationId,
      shortCode: makeShortCode(),
      channel: input.channel,
      fulfillment: input.fulfillment,
      status,
      paymentStatus,
      contactName: input.contact.name,
      contactPhone: input.contact.phone,
      contactEmail: input.contact.email ?? null,
      /**
       * `=== true`, not `??`: the shape check has already refused everything that is
       * not a boolean, and this stays an identity test so that a future relaxation of
       * that check cannot turn a truthy string into an opt-in here.
       *
       * The timestamp is `placedAt` — the order's one instant — rather than a second
       * `new Date()`, so consent is stamped at the same moment the order is, and the
       * two can never be read as having happened in the wrong sequence.
       */
      smsMarketingConsent: input.smsMarketingConsent === true,
      consentAt: input.smsMarketingConsent === true ? placedAt : null,
      /**
       * Only for an order that is already the kitchen's problem. A card order sits
       * at PENDING_PAYMENT until Stripe confirms, and a promise made before the
       * customer has paid is a promise with an unknown amount of it already spent —
       * Task 9 sets it when the order reaches NEW.
       */
      quotedReadyAt: status === 'NEW'
        ? new Date(placedAt.getTime() + location.prepTimeMinutes * 60_000)
        : null,
      ...totals,
      menuSnapshotId: snapshot.id,
    }
    // The defensive invariant, run on the row itself with nothing left between the
    // check and the INSERT. Not a restatement of the arithmetic: the bug it traps is
    // assembly — a number that arrived under the wrong key on the way here.
    assertTotalsBalance(values)

    const order = await ordersRepo(tx).insertOrder(values, lines.map((line) => line.row))

    await tx.insert(orderEvents).values({
      orderId: order.id,
      type: 'created',
      actor: 'customer',
      payload: createdPayload(input, { status, paymentStatus, snapshot, totals, lineCount: lines.length }),
    })

    return {
      orderId: order.id,
      shortCode: order.shortCode,
      totalCents: order.totalCents,
      status: order.status,
    }
  })
}

/**
 * `locations` is not under RLS — it is the tenancy root, and there is nothing to
 * scope it to until a location exists. It is read on `tx` anyway rather than through
 * `db()`, so the tax rate that prices the order is the one in force in the same
 * transaction that writes it.
 */
async function readLocation(tx: ScopedTx, locationId: string) {
  const [location] = await tx
    .select({
      status: locations.status,
      taxRatePer100k: locations.taxRatePer100k,
      prepTimeMinutes: locations.prepTimeMinutes,
      // The restaurant's own day is what the unpaid-order cap counts inside. Read on
      // the same row as the tax rate so one transaction answers every question it has
      // about this location.
      timezone: locations.timezone,
    })
    .from(locations)
    .where(eq(locations.id, locationId))
    .limit(1)
  // A caller ordering from a location that does not exist has a bug. Answering
  // "closed" would hide it behind a plausible-looking rejection — the same ruling
  // `isOpenAt` makes.
  if (!location) throw new Error(`Unknown location ${locationId}`)
  return location
}

/**
 * How many open pay-at-pickup orders this phone already has at this restaurant today,
 * and a refusal if that is already the cap.
 *
 * Every conjunct in the WHERE is load-bearing:
 *
 * - **`paymentStatus = 'PAY_ON_PICKUP'`** — a card order has money behind it and is
 *   not what this guards against.
 * - **not COMPLETED / REJECTED / CANCELED** — the restaurant is finished with those.
 *   Without this, a regular who collects every order they place is locked out by
 *   their own good behaviour, which is the opposite of the intent.
 * - **`createdAt >=` the start of today *at the restaurant*** — `startOfLocalDay`, not
 *   a UTC day and not "the last 24 hours". A rolling window would let one bad evening
 *   bleed into the next day's service, and UTC's day rolls at 8pm in New York.
 *
 * **No `location_id` predicate**, and that is the house rule rather than an oversight:
 * the transaction is scoped and RLS supplies it. Writing it back here would hide the
 * day RLS stops working — see `ordersRepo`.
 */
async function assertUnderUnpaidCap(
  tx: ScopedTx,
  locationId: string,
  phone: string,
  at: Date,
  timezone: string,
): Promise<void> {
  /**
   * **One pay-at-pickup order per phone per restaurant at a time**, until this
   * transaction commits or rolls back.
   *
   * The abuse the cap exists for is a script, and a script sends its orders at once.
   * READ COMMITTED gives the COUNT below no lock, so without this every transaction in
   * a burst counts the same nine and inserts — overshooting by however many requests
   * landed together, which on serverless is one per instance. With it, the next order
   * in line waits here until this one is written or gone, and READ COMMITTED's fresh
   * snapshot *per statement* is what then lets its COUNT see this order's row.
   *
   * Transaction-scoped, like the fan-out's per-order lock, so nothing can leak it.
   * Keyed on location **and** phone, and namespaced, so it contends with nothing else:
   * not another customer, not another restaurant, not that per-order lock. The key is
   * a lock name, not a predicate — the COUNT still scopes by RLS alone.
   */
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`unpaid-cap:${locationId}:${phone}`}, 0))`)

  const [row] = await tx
    .select({ open: count() })
    .from(orders)
    .where(and(
      eq(orders.contactPhone, phone),
      eq(orders.paymentStatus, 'PAY_ON_PICKUP'),
      notInArray(orders.status, ['COMPLETED', 'REJECTED', 'CANCELED']),
      gte(orders.createdAt, startOfLocalDay(at, timezone)),
    ))
  const open = row?.open ?? 0
  if (open >= MAX_OPEN_UNPAID_ORDERS_PER_PHONE_PER_DAY) throw new UnpaidOrderCapError(open)
}

/**
 * The input shape, checked before a connection is opened. Nothing here reads the
 * database — and the id checks are the reason it has to stay that way: a malformed
 * uuid raises 22P02 inside the query, which poisons the whole transaction and comes
 * back as a 500 on a public write path, for whatever a client happened to put in the
 * body.
 */
function assertInputShape(input: CreateOrderInput): void {
  assertUuid('locationId', input.locationId)
  if (input.items.length === 0) {
    throw new InvalidOrderInputError('An order must have at least one line')
  }
  if (input.items.length > MAX_LINES_PER_ORDER) {
    throw new InvalidOrderInputError(
      `An order may have at most ${MAX_LINES_PER_ORDER} lines, got ${input.items.length}`,
    )
  }
  // Not decoration: the ternaries below map `card` to "money is owed" and anything
  // else to "pay at the counter", so an unrecognised payment mode would quietly
  // become a free order.
  if (input.payment !== 'card' && input.payment !== 'pay_on_pickup') {
    throw new InvalidOrderInputError(`Unknown payment mode ${JSON.stringify(input.payment)}`)
  }
  // Same shape of hazard: the delivery fee is hardcoded 0 for pickup.
  if (input.fulfillment !== 'pickup') {
    throw new InvalidOrderInputError(`Only pickup orders are supported, got ${JSON.stringify(input.fulfillment)}`)
  }
  // A different flavor of the same hazard: `channel` is a Postgres enum
  // (`order_channel`), so an unrecognised value would not fail here at all — it
  // would sail through the pricing read, burn a whole transaction, and only then
  // 22P02 at the INSERT. Checked as a literal, like payment and fulfillment above.
  if (input.channel !== 'web' && input.channel !== 'voice' && input.channel !== 'sms') {
    throw new InvalidOrderInputError(`Unknown channel ${JSON.stringify(input.channel)}`)
  }
  if (!Number.isSafeInteger(input.tipCents) || input.tipCents < 0) {
    throw new InvalidOrderInputError(`Tip must be a whole number of cents and not negative, got ${input.tipCents}`)
  }
  /**
   * **Bounded, because the tip is the one money value the client supplies.**
   * Everything else on the receipt is read from the menu inside the transaction;
   * this arrives in the request body. Unbounded, `Number.isSafeInteger` accepts
   * 9007199254740991, and that total is handed to Stripe verbatim — refused *after*
   * the order row is committed, which parks a row at PENDING_PAYMENT and answers a
   * 500. Pay-at-pickup does not even get that: it prints the nonsense total.
   *
   * Refused here rather than clamped: a tip is an instruction, and silently charging
   * a different number than the one a customer typed is the one thing this file
   * exists to prevent. See `MAX_TIP_CENTS` for the bound's argument.
   */
  if (input.tipCents > MAX_TIP_CENTS) {
    throw new InvalidOrderInputError(
      `A tip may be at most ${MAX_TIP_CENTS} cents ($${(MAX_TIP_CENTS / 100).toFixed(0)}), got ${input.tipCents}`,
    )
  }
  // The phone number is the whole identity of a guest order — it is how a kitchen
  // chases a no-show pickup — so a blank one is not a valid order.
  if (input.contact.name.trim() === '') throw new InvalidOrderInputError('An order needs a contact name')
  if (input.contact.phone.trim() === '') throw new InvalidOrderInputError('An order needs a contact phone number')
  /**
   * **E.164 or nothing, on every channel.**
   *
   * `orders.contact_phone` is plain `text`, and everything downstream of it assumes
   * E.164 — most sharply `sendSms`, which refuses any other shape *at send time*. By
   * then the order is committed, the kitchen has the ticket, and the only symptom is
   * a customer who is never texted. Checked here it is a rejection the caller can
   * still act on.
   *
   * **Shape, not plausibility.** This says "a `+`, a country code that does not start
   * with 0, 7 to 15 digits" — the standard's own grammar. It deliberately does not
   * know that US area codes never start with 1, because that is a NANP rule and this
   * column holds every country's numbers. Turning what a US customer *types* into
   * this shape is the web form's job (`normalizePhone`); re-checking it here is what
   * makes the rule hold for the voice and SMS agents too, which call `createOrder`
   * directly with whatever a transcription handed back.
   */
  if (!E164.test(input.contact.phone)) {
    throw new InvalidOrderInputError(
      `Contact phone must be an E.164 number like +15551234567, got ${JSON.stringify(input.contact.phone)}`,
    )
  }
  /**
   * Consent is a boolean or it is absent. **Not coerced**, because the two shapes a
   * form serialiser actually produces — the string `'false'` and the string `'on'` —
   * are both truthy, and a coercion here opts a customer into marketing they
   * declined. That is a legal problem rather than a support ticket, so it is a
   * refusal.
   */
  if (input.smsMarketingConsent !== undefined && typeof input.smsMarketingConsent !== 'boolean') {
    throw new InvalidOrderInputError(
      `smsMarketingConsent must be a boolean when present, got ${JSON.stringify(input.smsMarketingConsent)}`,
    )
  }
  // Lower stakes than channel — `contact_email` is a nullable text column, so
  // there is no constraint for a wrong-typed value to violate — but still a value
  // the client fully controls reaching storage with no shape check at all today.
  if (input.contact.email !== undefined) {
    if (typeof input.contact.email !== 'string') {
      throw new InvalidOrderInputError('Contact email must be a string when present')
    }
    if (input.contact.email.length > MAX_TEXT_FIELD_LENGTH) {
      throw new InvalidOrderInputError(`Contact email must be at most ${MAX_TEXT_FIELD_LENGTH} characters`)
    }
  }

  for (const line of input.items) {
    assertUuid('menuItemId', line.menuItemId)
    // `?? []` throughout: absent means "no modifiers on this line", which is the
    // common case, not a malformed one. A present-but-not-an-array value is refused
    // here rather than left to blow up as a TypeError deeper in.
    if (line.modifierOptionIds !== undefined && !Array.isArray(line.modifierOptionIds)) {
      throw new InvalidOrderInputError(
        `modifierOptionIds must be an array when present, got ${JSON.stringify(line.modifierOptionIds)}`,
      )
    }
    for (const optionId of line.modifierOptionIds ?? []) assertUuid('modifierOptionId', optionId)
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY_PER_LINE) {
      throw new InvalidOrderInputError(
        `Quantity must be a whole number between 1 and ${MAX_QTY_PER_LINE}, got ${line.qty}`,
      )
    }
    const seen = new Set<string>()
    for (const optionId of line.modifierOptionIds ?? []) {
      if (seen.has(optionId)) {
        // (order_item_id, modifier_option_id) is the primary key of
        // order_item_modifiers, so "extra shot ×2" cannot be recorded. Saying so
        // here beats a 23505 from the driver — and beats silently charging for one.
        throw new InvalidOrderInputError(
          `Modifier option ${optionId} is chosen twice on one line; a repeated modifier is not representable`,
        )
      }
      seen.add(optionId)
    }
    // Same as the email check above: `notes` is a nullable text column with
    // nothing to stop a non-string value reaching it unchecked.
    if (line.notes !== undefined) {
      if (typeof line.notes !== 'string') {
        throw new InvalidOrderInputError('Line notes must be a string when present')
      }
      if (line.notes.length > MAX_TEXT_FIELD_LENGTH) {
        throw new InvalidOrderInputError(`Line notes must be at most ${MAX_TEXT_FIELD_LENGTH} characters`)
      }
    }
  }
}

function assertUuid(label: string, value: string): void {
  if (!isUuid(value)) throw new InvalidOrderInputError(`${label} must be a uuid, got ${JSON.stringify(value)}`)
}

/**
 * The one menu an order may be priced from — the same one `buildMenuSnapshot` roots
 * at, and the same ruling: exactly one active menu or nothing.
 *
 * This is deliberately checked on the order path as well as in the snapshot builder.
 * `getOrBuildCurrentSnapshot` hands back the last good snapshot when a location has
 * none or two active menus, and without this check an order would take that stale
 * payload and sell from a menu that cannot currently be pinned at all.
 */
async function activeMenuIdFor(tx: ScopedTx, locationId: string): Promise<string> {
  const active = await tx.select({ id: menus.id }).from(menus).where(eq(menus.isActive, true))
  if (active.length !== 1) throw new MenuUnavailableError(locationId, active.length)
  return active[0].id
}

type PricedLine = { row: NewOrderLine; lineTotalCents: number }

/**
 * Turns the ids in the request into priced order lines, against the live menu.
 *
 * Every rejection the spec names happens here, in one pass: unknown ids, 86'd
 * dishes, 86'd options, options stapled onto a dish that does not offer them, and
 * min/max violations against **the item's effective limits** — `minOverride ??
 * group.minSelect`, which is the same rule `buildMenuSnapshot` pins into the
 * payload, so what is enforced and what is on file cannot disagree.
 */
async function priceLines(tx: ScopedTx, input: CreateOrderInput): Promise<PricedLine[]> {
  // Resolved first, and it can refuse the order outright: the snapshot roots at the
  // single active menu, so pricing from anywhere else would charge for a dish the
  // pinned evidence does not contain.
  const activeMenuId = await activeMenuIdFor(tx, input.locationId)
  const requestedIds = [...new Set(input.items.map((line) => line.menuItemId))]
  // RLS narrows this to the scoped location, which is what makes another
  // restaurant's item id read as "no such dish" rather than pricing onto the order.
  const live = await tx.query.menuItems.findMany({
    where: inArray(menuItems.id, requestedIds),
    columns: { id: true, name: true, basePriceCents: true, is86d: true, isActive: true },
    with: {
      // Which menu the dish hangs off. `menu_items.isActive` does not answer that:
      // a whole menu can be switched off with every item on it still flagged active.
      category: { columns: { menuId: true } },
      modifierGroupLinks: {
        columns: { minOverride: true, maxOverride: true },
        with: {
          group: {
            columns: { id: true, name: true, minSelect: true, maxSelect: true },
            with: {
              options: {
                // Inactive means "off the menu" — the snapshot leaves those out too,
                // so from the customer's side the option does not exist.
                where: eq(modifierOptions.isActive, true),
                columns: { id: true, name: true, priceDeltaCents: true, is86d: true },
              },
            },
          },
        },
      },
    },
  })
  const byId = new Map(live.map((item) => [item.id, item]))

  return input.items.map((line) => {
    const item = byId.get(line.menuItemId)
    // Three ways to not be on sale, one answer. `isActive: false` is a retired dish —
    // still referenced by old orders, absent from the menu the customer saw. A dish on
    // a different menu is last winter's, whatever its own flag says.
    if (!item || !item.isActive || item.category.menuId !== activeMenuId) {
      throw new UnknownMenuItemError(line.menuItemId)
    }
    if (item.is86d) throw new ItemUnavailableError(item.id, item.name)

    // Only the groups this dish actually offers, with the limits this dish enforces.
    const groups = item.modifierGroupLinks.map((link) => ({
      id: link.group.id,
      name: link.group.name,
      // `??`, not `||`: an override of 0 is a real value ("optional on this dish").
      minSelect: link.minOverride ?? link.group.minSelect,
      maxSelect: link.maxOverride ?? link.group.maxSelect,
      options: link.group.options,
    }))

    const chosen = (line.modifierOptionIds ?? []).map((optionId) => {
      for (const group of groups) {
        const option = group.options.find((o) => o.id === optionId)
        if (option) return { group, option }
      }
      // Either no such option, or one from a group this dish does not offer. Both
      // are the same answer to the customer, and refusing the second is what stops
      // a client stapling any price delta it likes onto any dish.
      throw new UnknownModifierOptionError(optionId, item.id, item.name)
    })
    for (const { option } of chosen) {
      if (option.is86d) throw new OptionUnavailableError(option.id, option.name)
    }

    // Every group is checked, including the ones nothing was chosen from — that is
    // where a missing mandatory choice hides.
    for (const group of groups) {
      const count = chosen.filter((c) => c.group.id === group.id).length
      if (count < group.minSelect || count > group.maxSelect) {
        throw new ModifierSelectionError(group.id, group.name, group.minSelect, group.maxSelect, count)
      }
    }

    const unitPriceCents = unitPriceCentsFor(item.basePriceCents, chosen.map((c) => c.option.priceDeltaCents))
    const lineTotalCents = lineTotalCentsFor(unitPriceCents, line.qty)
    return {
      lineTotalCents,
      row: {
        menuItemId: item.id,
        // The name is copied onto the row, not joined back later: the dish gets
        // renamed and the order from last March must still say what was bought.
        nameSnapshot: item.name,
        qty: line.qty,
        unitPriceCents,
        lineTotalCents,
        notes: line.notes ?? null,
        modifiers: chosen.map(({ option }) => ({
          modifierOptionId: option.id,
          nameSnapshot: option.name,
          priceDeltaCents: option.priceDeltaCents,
        })),
      },
    }
  })
}

function totalsFor(lines: PricedLine[], tipCents: number, taxRatePer100k: number): Totals {
  const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0)
  const parts = {
    subtotalCents,
    taxCents: taxCentsFor(subtotalCents, taxRatePer100k),
    tipCents,
    deliveryFeeCents: PICKUP_DELIVERY_FEE_CENTS,
    discountCents: NO_DISCOUNT_CENTS,
  }
  return { ...parts, totalCents: totalCentsFor(parts) }
}

/**
 * What the `created` event carries. `order_events` is the table you read at 7pm on
 * a Friday when an owner says the order never arrived and a customer says they were
 * charged — so it answers "what was this order, and how did it get here" without
 * joining anything.
 */
function createdPayload(
  input: CreateOrderInput,
  context: {
    status: OrderStatus
    paymentStatus: PaymentStatus
    snapshot: { id: string; version: number }
    totals: Totals
    lineCount: number
  },
): OrderEventPayload {
  return {
    channel: input.channel,
    fulfillment: input.fulfillment,
    payment: input.payment,
    status: context.status,
    paymentStatus: context.paymentStatus,
    menuSnapshotId: context.snapshot.id,
    menuSnapshotVersion: context.snapshot.version,
    ...context.totals,
    itemCount: context.lineCount,
  }
}
