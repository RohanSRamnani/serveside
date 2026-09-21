import type { Order } from '@/db/schema'
import type { OrderWithLines } from '@/repo/orders-repo'
import { formatCents } from '@/lib/money'

/**
 * The kitchen ticket: the plain-text string a Star CloudPRNT printer collects and
 * prints, and the only artefact in this system a cook actually reads.
 *
 * Rendered **once**, at fan-out, and stored verbatim in `print_jobs.payload` — for
 * the same reason `orders.menu_snapshot_id` exists. A reprint three hours later must
 * reproduce the ticket that was printed, not re-render against a menu, a price or a
 * promised time that has since moved.
 *
 * Every rule here is a physical constraint, not a style choice:
 *
 * - **32 columns.** mC-Print3 roll, default font. A 33rd character does not wrap and
 *   does not scroll — it is cut off, which is how a dish loses the half of its name
 *   that said "no peanuts". Nothing is truncated here; long text wraps, indented.
 * - **Money is right-aligned in a fixed column** and carries no `$`. A currency
 *   symbol that appears on some rows and not others is a column that never lines up.
 * - **Times print in the restaurant's wall clock**, from `locations.timezone` —
 *   never the server's, which is UTC in production. Hence `timezone` on the input:
 *   it is not on the order row, and a ticket promising 23:45 for a 7:45 pickup is
 *   worse than a ticket with no time at all.
 * - **ASCII, with one deliberate exception**: `×` in the `2× Butter Chicken` line,
 *   which the plan pins. It is U+00D7, two bytes in UTF-8, so the CloudPRNT GET
 *   serves `text/plain; charset=utf-8` — a printer left on a legacy code page would
 *   print `2Ã—`. Keeping the rest of the ticket ASCII means that is the only
 *   character encoding can spoil.
 */

/** Characters per line. The paper, not a preference. */
export const TICKET_WIDTH = 32

/** Wrapped text and modifier lines hang under their dish by this much. */
const INDENT = 3

/**
 * What `renderTicket` needs: the order, its lines with their modifiers, and the
 * location's IANA timezone. Built by `ordersRepo.getWithItems` plus one field from
 * `locations` — the timezone is deliberately required rather than defaulted, because
 * every default is some restaurant's wrong answer.
 */
export type OrderWithItems = OrderWithLines & { timezone: string }

/** How the counter reads the money state off the top of the ticket. */
const PAYMENT_LABEL: Record<Order['paymentStatus'], string> = {
  PAID: 'PAID',
  PAY_ON_PICKUP: 'PAY AT PICKUP',
  REQUIRES_PAYMENT: 'UNPAID',
  REFUNDED: 'REFUNDED',
}

export function renderTicket(order: OrderWithItems): string {
  const out: string[] = []

  // The short code, as big as plain text gets: centred, alone, fenced. It is what
  // the customer says at the counter and the only thing on here read from 3 feet away.
  out.push(rule('='))
  out.push(centre(`*** ${order.shortCode} ***`))
  out.push(rule('='))

  // Fulfilment and money state on one line: a cook who cannot tell a paid order from
  // a pay-at-pickup one gives food away.
  out.push(...row(order.fulfillment.toUpperCase(), PAYMENT_LABEL[order.paymentStatus]))
  // Wrapped, though `Scheduled Mon Sep 21 12:45 PM` is 29 columns and cannot
  // overflow today: the day someone lengthens that label, it must wrap rather than
  // lose the time off the right edge.
  out.push(...wrap(when(order)))

  out.push(rule('-'))
  out.push(...wrap(order.contactName))
  // Phone on its own line, unwrapped and unlabelled: it is what a kitchen dials when
  // a pickup goes cold on the pass, and it has to be findable at a glance.
  out.push(...wrap(order.contactPhone))

  out.push(rule('-'))
  for (const line of order.items) {
    out.push(...row(`${line.qty}× ${line.nameSnapshot}`, formatCents(line.lineTotalCents)))
    // Modifiers carry no price. The line total above already includes their deltas,
    // and the kitchen is being told what to cook, not what it cost.
    for (const modifier of line.modifiers) out.push(...wrap(modifier.nameSnapshot, INDENT))
    if (hasText(line.notes)) out.push(...wrap(`>> ${line.notes.trim()}`, INDENT))
  }

  // Labelled, and below the lines rather than beside them: an unlabelled `>>` at the
  // foot of the list reads as a note on the last dish, and "no cilantro" applied to
  // one dish instead of the order is a remake.
  if (hasText(order.notes)) {
    out.push(rule('-'))
    out.push('ORDER NOTE')
    out.push(...wrap(`>> ${order.notes.trim()}`))
  }

  out.push(rule('-'))
  out.push(...row('Subtotal', formatCents(order.subtotalCents)))
  out.push(...row('Tax', formatCents(order.taxCents)))
  // Only when there is one. A run of `0.00` rows is paper spent to say nothing, and
  // it buries the two numbers that are always true.
  if (order.tipCents !== 0) out.push(...row('Tip', formatCents(order.tipCents)))
  if (order.deliveryFeeCents !== 0) out.push(...row('Delivery', formatCents(order.deliveryFeeCents)))
  // Stored positive and subtracted from the total (`orders.ts`), so it prints negative.
  if (order.discountCents !== 0) out.push(...row('Discount', formatCents(-order.discountCents)))

  out.push(rule('-'))
  out.push(...row('TOTAL', formatCents(order.totalCents)))
  out.push(rule('='))

  // Trailing newline: the last line is a line, not a fragment the cutter lands on.
  return `${out.join('\n')}\n`
}

/**
 * The promised time, in the restaurant's own clock.
 *
 * Three states, and they are not interchangeable: a time the customer *chose*
 * (`scheduledFor`) outranks the one we quoted them, and an order with neither is a
 * card order whose payment has not landed — the clock starts when the money does, so
 * there is genuinely nothing to promise yet. Printing a blank there, or an epoch, is
 * how a kitchen starts cooking a ticket it cannot date.
 */
function when(order: OrderWithItems): string {
  if (order.scheduledFor) return `Scheduled ${wallClock(order.scheduledFor, order.timezone)}`
  if (order.quotedReadyAt) return `Ready ${wallClock(order.quotedReadyAt, order.timezone)}`
  return 'ASAP'
}

/**
 * `Mon Sep 21 7:45 PM`, assembled from parts rather than from a format string.
 *
 * `Intl.DateTimeFormat().format()` would be shorter and would also let ICU decide
 * where the commas go — which has changed between ICU releases, and would move a
 * golden test on a Node upgrade. `formatToParts` pins the pieces and lets this file
 * own the punctuation.
 */
function wallClock(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('weekday')} ${part('month')} ${part('day')} ${part('hour')}:${part('minute')} ${part('dayPeriod')}`
}

function rule(char: string): string {
  return char.repeat(TICKET_WIDTH)
}

/** Centred, with no trailing pad — trailing spaces are invisible and make a golden brittle. */
function centre(text: string): string {
  const slack = TICKET_WIDTH - text.length
  return slack > 0 ? ' '.repeat(Math.floor(slack / 2)) + text : text
}

/**
 * `left` and `right` on one line, right flush to column 32, with at least one space
 * between them. A `left` too long to fit wraps onto hanging continuation lines while
 * the `right` value stays on the first — the money column must never move, because a
 * cook scanning the right edge for a total is the whole reason it is a column.
 */
function row(left: string, right: string): string[] {
  const [head, ...rest] = chunks(left, TICKET_WIDTH - right.length - 1, TICKET_WIDTH - INDENT)
  return [head.padEnd(TICKET_WIDTH - right.length) + right, ...rest.map(indented)]
}

/** A block of text at one indent, wrapped to the paper. */
function wrap(text: string, indent = 0): string[] {
  const width = TICKET_WIDTH - indent
  return chunks(text, width, width).map((line) => ' '.repeat(indent) + line)
}

function indented(line: string): string {
  return ' '.repeat(INDENT) + line
}

/**
 * Hard-wraps to the paper: the first line to `firstWidth`, the rest to `restWidth`,
 * with no indentation of its own — the callers own that.
 *
 * Breaks on spaces, and splits **mid-word** when a single word is wider than the
 * line. A 40-character unbroken dish name is rare; a truncated one is a missing
 * allergy note, so it gets broken rather than cut.
 */
function chunks(text: string, firstWidth: number, restWidth: number): string[] {
  // A `right` value wide enough to leave no room would otherwise spin the break loop.
  const first = Math.max(1, firstWidth)
  const rest = Math.max(1, restWidth)
  const lines: string[] = []
  let current = ''
  let width = first

  const flush = () => {
    lines.push(current)
    current = ''
    width = rest
  }

  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      // Fill what is left of this line, then keep breaking until the tail fits.
      const room = width - (current ? current.length + 1 : 0)
      if (room > 0) {
        current = current ? `${current} ${word.slice(0, room)}` : word.slice(0, room)
        word = word.slice(room)
      }
      flush()
    }
    if (!current) current = word
    else if (current.length + 1 + word.length <= width) current += ` ${word}`
    else { flush(); current = word }
  }
  if (current || lines.length === 0) flush()
  return lines
}

/** Notes are nullable, and a note of `'   '` is not a note. */
function hasText(value: string | null): value is string {
  return value !== null && value.trim().length > 0
}
