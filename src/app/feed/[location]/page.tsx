import type { Metadata } from 'next'
import { requireLocationAccess } from '@/lib/authz'
import { readFeed } from '@/domain/feed'
import FeedClient from './feed-client'

/**
 * The tablet on the counter. A server component does the two things a browser must
 * not be trusted with — proving who is asking and reading the board — and hands the
 * result to the client that polls from there.
 *
 * **Never cached.** The page's whole content depends on who is signed in, and a
 * cached render served to a second restaurant would be the worst bug this codebase
 * could have. `auth()` already forces a dynamic render by reading headers; this says
 * so out loud so that a future caching change has to argue with a line of code.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Kitchen feed',
  // A tablet that is left on a counter all day should not be findable, and should not
  // go to sleep behind a browser chrome nobody asked for.
  robots: { index: false, follow: false },
}

/**
 * How far back the board reaches, fixed for the life of the page.
 *
 * Long enough to cover a whole service including a long lunch-to-dinner split, short
 * enough that an order abandoned at NEW three weeks ago is not still chiming on a
 * Tuesday morning. Those old orders are a real problem — they are exactly the orders
 * nobody dealt with — but a kitchen board at 11am is the wrong place to raise it, and
 * Task 14's stale-order alert is the right one.
 */
const WINDOW_HOURS = 12

export default async function FeedPage({ params }: PageProps<'/feed/[location]'>) {
  const { location: slug } = await params
  const access = await requireLocationAccess(slug)

  if (!access.ok) {
    // A page, not an API: someone who is simply not signed in gets sent to sign in
    // rather than shown a status code. `signIn` throws, so nothing below runs.
    if (access.status === 401 && access.signIn) access.signIn()
    return <Refusal message={access.message} />
  }

  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const initial = await readFeed(access.location.id, since)

  return (
    <FeedClient
      locationSlug={access.location.slug}
      locationName={access.location.name}
      initial={initial}
      since={since}
    />
  )
}

/**
 * Big, plain, and it says what to do. Whoever reads this is standing in a kitchen
 * during service with a tablet that will not show them their orders.
 */
function Refusal({ message }: { message: string }) {
  return (
    <main style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: '16px',
      padding: '32px',
      background: '#111',
      color: '#fff',
      fontFamily: 'system-ui, sans-serif',
    }}
    >
      <h1 style={{ fontSize: '40px', fontWeight: 800 }}>Can’t open this feed</h1>
      <p style={{ fontSize: '28px', color: '#ccc' }}>{message}</p>
    </main>
  )
}
