import { serve } from 'inngest/next'
import { inngest } from '@/inngest/client'
import { functions } from '@/inngest/functions'

/**
 * Where Inngest reaches us.
 *
 * Three verbs, and all three are needed: `PUT` registers the app (the dev server and
 * the cloud both call it to learn what functions exist), `POST` is an actual function
 * invocation, and `GET` is introspection. A deploy missing one of them looks healthy
 * and quietly never runs anything.
 *
 * **A function not in `src/inngest/functions.ts` does not exist.** It is registered by
 * being in that array, not by being defined — so a new Inngest function is two edits,
 * and forgetting the second means events are accepted and nothing ever runs. The list
 * lives there rather than here so a test can read it; a route module may only export
 * the handlers Next knows about.
 *
 * Locally: `npx inngest-cli dev` (no account needed) discovers this route and gives
 * you a dashboard of runs and step-by-step failures.
 *
 * **This URL invokes functions, so in production it is only as safe as
 * `INNGEST_SIGNING_KEY`.** The SDK verifies every request against it; without one it
 * refuses to serve rather than running unsigned work, which is the right way round —
 * an open version of this endpoint would let anyone fan out any order id they could
 * guess. The key is a deploy obligation, not a nicety.
 */
export const { GET, POST, PUT } = serve({ client: inngest, functions })
