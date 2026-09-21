import { eq, inArray } from 'drizzle-orm'
import { locations, menuItems, modifierOptions, orderEvents, paymentStatus as paymentStatusEnum } from '@/db/schema'
import type { OrderEventPayload } from '@/db/schema'
import { withLocation, type ScopedTx } from '@/repo/scoped'
import { ordersRepo, type NewOrderLine } from '@/repo/orders-repo'
import { isOpenAt, type ClosedReason } from './hours'
import { getOrBuildCurrentSnapshot } from './snapshot'
import type { OrderStatus } from './order-status'
import {
  taxCentsFor, unitPriceCentsFor, lineTotalCentsFor, totalCentsFor, assertTotalsBalance, type Totals,
} from '@/lib/money'
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
  items: Array<{ menuItemId: string; qty: number; modifierOptionIds: string[]; notes?: string }>
  tipCents: number
  payment: 'card' | 'pay_on_pickup'
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

/** Pickup only, so there is no fee to compute. Named rather than inlined as a bare 0. */
const PICKUP_DELIVERY_FEE_CENTS = 0
/** Discounts land with promotions; the column exists and is always 0 for now. */
const NO_DISCOUNT_CENTS = 0

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

    const lines = await priceLines(tx, input)
    const totals = totalsFor(lines, input.tipCents, location.taxRateBps)

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
      taxRateBps: locations.taxRateBps,
      prepTimeMinutes: locations.prepTimeMinutes,
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

/** The input shape, checked before a connection is opened. Nothing here reads the database. */
function assertInputShape(input: CreateOrderInput): void {
  if (input.items.length === 0) {
    throw new InvalidOrderInputError('An order must have at least one line')
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
  if (!Number.isSafeInteger(input.tipCents) || input.tipCents < 0) {
    throw new InvalidOrderInputError(`Tip must be a whole number of cents and not negative, got ${input.tipCents}`)
  }
  // The phone number is the whole identity of a guest order — it is how a kitchen
  // chases a no-show pickup — so a blank one is not a valid order.
  if (input.contact.name.trim() === '') throw new InvalidOrderInputError('An order needs a contact name')
  if (input.contact.phone.trim() === '') throw new InvalidOrderInputError('An order needs a contact phone number')

  for (const line of input.items) {
    if (!Number.isInteger(line.qty) || line.qty < 1) {
      throw new InvalidOrderInputError(`Quantity must be a whole number of at least 1, got ${line.qty}`)
    }
    const seen = new Set<string>()
    for (const optionId of line.modifierOptionIds) {
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
  }
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
  const requestedIds = [...new Set(input.items.map((line) => line.menuItemId))]
  // RLS narrows this to the scoped location, which is what makes another
  // restaurant's item id read as "no such dish" rather than pricing onto the order.
  const live = await tx.query.menuItems.findMany({
    where: inArray(menuItems.id, requestedIds),
    columns: { id: true, name: true, basePriceCents: true, is86d: true, isActive: true },
    with: {
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
    // `isActive: false` is a retired dish: still referenced by old orders, not
    // orderable, and absent from the menu the customer saw.
    if (!item || !item.isActive) throw new UnknownMenuItemError(line.menuItemId)
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

    const chosen = line.modifierOptionIds.map((optionId) => {
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

function totalsFor(lines: PricedLine[], tipCents: number, taxRateBps: number): Totals {
  const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0)
  const parts = {
    subtotalCents,
    taxCents: taxCentsFor(subtotalCents, taxRateBps),
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
