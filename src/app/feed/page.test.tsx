import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { seedLocationWithMenu, seedPaidOrder, linkClerkOrg, type SeededMenu } from '@/test/seed'

/**
 * The tablet page end to end, minus the browser: a Clerk session goes in, a location
 * slug goes in, and an order that is actually in the database comes out as markup.
 *
 * Worth having separately from the route tests because this is the wiring nothing
 * else exercises — route segment to authorization to a scoped read to the component's
 * first paint. A server component is an ordinary async function, so it is called as
 * one and its element rendered; only `useEffect` is missing, which is the poll, the
 * chime and the taps. Those are the manual check.
 */

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('@clerk/nextjs/server', () => ({ auth }))

const FeedPage = (await import('./[location]/page')).default

function render(slug: string) {
  return FeedPage({
    params: Promise.resolve({ location: slug }),
    searchParams: Promise.resolve({}),
  }).then(renderToStaticMarkup)
}

async function restaurant(): Promise<SeededMenu & { clerkOrgId: string }> {
  const loc = await seedLocationWithMenu()
  const clerkOrgId = await linkClerkOrg(loc.orgId)
  return { ...loc, clerkOrgId }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('/feed/[location]', () => {
  it('paints the board on the server, so a tablet never waits out an empty screen', async () => {
    const loc = await restaurant()
    await seedPaidOrder(loc.id)
    auth.mockResolvedValue({ userId: 'user_test_kitchen', orgId: loc.clerkOrgId })

    const markup = await render(loc.slug)
    expect(markup).toContain(loc.name)
    expect(markup).toContain('K7M2')
    expect(markup).toContain('Butter Chicken')
    expect(markup).toContain('Hot')
    expect(markup).toContain('Accept')
  })

  it('shows a refusal, and no orders at all, to a session from another restaurant', async () => {
    const mine = await restaurant()
    const theirs = await restaurant()
    await seedPaidOrder(mine.id)
    auth.mockResolvedValue({ userId: 'user_test_kitchen', orgId: theirs.clerkOrgId })

    const markup = await render(mine.slug)
    expect(markup).toContain('Can’t open this feed')
    // Not one byte of the other restaurant's board, not even its name.
    expect(markup).not.toContain('K7M2')
    expect(markup).not.toContain(mine.name)
  })

  it('refuses rather than rendering when nobody is signed in', async () => {
    const loc = await restaurant()
    // A real Clerk session object carries `redirectToSignIn`, and the page calls it —
    // this mock has none, which is the path where there is nowhere to send them.
    auth.mockResolvedValue({ userId: null, orgId: null })

    expect(await render(loc.slug)).toContain('Can’t open this feed')
  })
})
