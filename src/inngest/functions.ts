import type { InngestFunction } from 'inngest'
import { orderCreated } from './order-created'
import { unsnooze } from './unsnooze'

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
 */
export const functions: InngestFunction.Any[] = [orderCreated, unsnooze]
