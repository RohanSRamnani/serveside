import { describe, it, expect } from 'vitest'
import { withLocation } from '@/repo/scoped'
import { ordersRepo } from '@/repo/orders-repo'
import { seedLocationWithMenu, seedTicketOrder } from '@/test/seed'
import { renderTicket, TICKET_WIDTH, type OrderWithItems } from './ticket'

/**
 * The ticket is the product. Everything else in this repo is a database row until
 * this string comes out of a printer in a kitchen — so it is pinned character for
 * character rather than probed with `toContain`, which is how a ticket quietly
 * starts printing the tax where the total used to be.
 *
 * The golden is built from a **real seeded order**, read back through the same
 * `getWithItems` Task 10 will use. A renderer tested against a hand-built literal
 * proves only that the literal matches itself; this proves the shape the database
 * actually hands back renders correctly — `Date` objects, `bigint({ mode: 'number' })`
 * cents, nullable notes and all.
 */
describe('renderTicket', () => {
  async function ticketFor(locationId: string, orderId: string): Promise<string> {
    const order = await withLocation(locationId, (tx) => ordersRepo(tx).getWithItems(orderId))
    if (!order) throw new Error('seeded order is not readable in its own location')
    // `timezone` is not on the order row: it comes from `locations`, and the ticket
    // prints the restaurant's wall clock, never the server's.
    return renderTicket({ ...order, timezone: 'America/New_York' })
  }

  it('prints the golden 32-column kitchen ticket', async () => {
    const loc = await seedLocationWithMenu()
    const order = await seedTicketOrder(loc.id)

    // Flush left on purpose: a template literal keeps every space, and an indented
    // golden would pin an indentation no printer ever sees.
    expect(await ticketFor(loc.id, order.id)).toBe(
`================================
          *** K7M2 ***
================================
PICKUP                      PAID
Ready Mon Sep 21 7:45 PM
--------------------------------
Rohan R
+15551234567
--------------------------------
2× Butter Chicken          42.00
   Extra Paneer
   Hot
   >> extra crispy
1× Lamb Rogan Josh         21.00
--------------------------------
ORDER NOTE
>> no cilantro
--------------------------------
Subtotal                   63.00
Tax                         5.51
Tip                         5.00
--------------------------------
TOTAL                      73.51
================================
`)
  })

  it('never emits a line wider than the paper', async () => {
    // The golden above proves one order. This proves the *rule* — a dish name long
    // enough to wrap is the case a golden written by hand never contains, and a
    // 33-character line on a 32-column printer does not scroll, it truncates.
    const loc = await seedLocationWithMenu()
    const order = await seedTicketOrder(loc.id)
    const row = await withLocation(loc.id, (tx) => ordersRepo(tx).getWithItems(order.id))

    const stretched: OrderWithItems = {
      ...row!,
      timezone: 'America/New_York',
      contactName: 'Bartholomew Fitzwilliam-Harrington the Third',
      notes: 'please please please do not put any cilantro anywhere near this order at all',
      items: [{
        ...row!.items[0],
        nameSnapshot: 'Slow Braised Kashmiri Lamb Shank with Saffron Pilaf',
        notes: 'cut into three portions and plate them separately for the kids',
        modifiers: [{ ...row!.items[0].modifiers[0], nameSnapshot: 'Extra Coriander Chutney On The Side' }],
      }],
    }

    for (const line of renderTicket(stretched).split('\n')) {
      expect(line.length, `"${line}" is ${line.length} columns`).toBeLessThanOrEqual(TICKET_WIDTH)
    }
  })

  it('says ASAP when nothing has promised a time yet, and names a scheduled one', async () => {
    // A card order is rendered before payment lands, so `quotedReadyAt` is null —
    // the clock starts when the money does. Printing an empty time, or the epoch,
    // is how a kitchen starts cooking a ticket it cannot date.
    const loc = await seedLocationWithMenu()
    const order = await seedTicketOrder(loc.id)
    const row = await withLocation(loc.id, (tx) => ordersRepo(tx).getWithItems(order.id))
    const base = { ...row!, timezone: 'America/New_York' }

    expect(renderTicket({ ...base, quotedReadyAt: null })).toContain('\nASAP\n')
    expect(renderTicket({ ...base, scheduledFor: new Date('2026-09-22T17:00:00Z') }))
      .toContain('\nScheduled Tue Sep 22 1:00 PM\n')
  })

  it('prints the payment state the counter needs, not just the money', async () => {
    // A cook who cannot tell a paid order from a pay-at-pickup one gives food away.
    const loc = await seedLocationWithMenu()
    const order = await seedTicketOrder(loc.id)
    const row = await withLocation(loc.id, (tx) => ordersRepo(tx).getWithItems(order.id))
    const base = { ...row!, timezone: 'America/New_York' }

    expect(renderTicket({ ...base, paymentStatus: 'PAY_ON_PICKUP' })).toContain('PICKUP             PAY AT PICKUP')
    expect(renderTicket({ ...base, fulfillment: 'delivery', paymentStatus: 'REFUNDED' }))
      .toContain('DELIVERY                REFUNDED')
  })

  it('shows the delivery fee and the discount, and only when there is one', async () => {
    const loc = await seedLocationWithMenu()
    const order = await seedTicketOrder(loc.id)
    const row = await withLocation(loc.id, (tx) => ordersRepo(tx).getWithItems(order.id))
    const base = { ...row!, timezone: 'America/New_York' }

    expect(renderTicket(base)).not.toContain('Delivery')
    expect(renderTicket(base)).not.toContain('Discount')

    const withFee = renderTicket({ ...base, deliveryFeeCents: 499, discountCents: 250, totalCents: 7600 })
    expect(withFee).toContain('Delivery                    4.99')
    // Stored positive, printed negative — it is subtracted from the total.
    expect(withFee).toContain('Discount                   -2.50')
    expect(withFee).toContain('TOTAL                      76.00')
  })
})
