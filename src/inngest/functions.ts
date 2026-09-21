import type { InngestFunction } from 'inngest'
import { orderCreated } from './order-created'
import { unsnooze } from './unsnooze'
import { staleOrderAlert } from './stale-order-alert'
import { printerHeartbeat } from './printer-heartbeat'
import { provenanceRefused } from './provenance-refused'

/**
 * Every Inngest function this app serves.
 *
 * **A function not in this array does not exist.** It is registered by being listed,
 * not by being defined, so a new one is two edits — and forgetting the second is
 * invisible: events are accepted and nothing ever runs. For a cron there is not even
 * an event to go missing, so the only symptom is work that silently never happens.
 *
 * It lives here rather than inline in `src/app/api/inngest/route.ts` so a test can
 * read it. A route module may only export the handlers Next knows about.
 *
 * **Three of these five are alarms**, which makes the point above sharper rather than
 * softer: an unregistered alarm is indistinguishable from an alarm that has nothing to
 * report. `src/app/api/inngest.test.ts` pins this list by name for that reason.
 */
export const functions: InngestFunction.Any[] = [
  orderCreated,
  staleOrderAlert,
  unsnooze,
  printerHeartbeat,
  provenanceRefused,
]
