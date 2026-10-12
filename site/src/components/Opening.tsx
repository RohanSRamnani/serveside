'use client'

import { useEffect } from 'react'
import AccentHeading from '@/components/AccentHeading'
import { cn } from '@/lib/utils'
import type { SectionProps } from '@/lib/types'
import type { OpeningSection } from '../types'
import { useScrollProgress } from '../use-scroll-progress'
import FeedTile from './opening/FeedTile'
import TicketTile from './opening/TicketTile'
import MenuTile from './opening/MenuTile'
import PlainHeading from './PlainHeading'
import s from './opening/opening.module.css'

/**
 * The opening. Overrides `hero`. Two beats, one ground.
 *
 * SCREEN ONE is unchanged: a solid paprika field, the wordmark, the offer in one
 * sentence rising out of a mask, and nothing else — no imagery, no price line,
 * no scroll cue. What Rohan killed here on the live site stays dead: product
 * screenshots scattered around the headline ("we can just make it one colour
 * honestly"), and a demo storefront that was not even filled out.
 *
 * THE MOVE is what follows it, and it is the site's signature. As the headline
 * scrolls away, three tiles come up over the paprika — not screenshots, not
 * mockups, three vignettes of the operation drawn in type and colour, filled
 * from the fictional Marigold menu rather than any real client's (see
 * opening/): an order arriving on the kitchen feed, its
 * ticket printing, tonight's special going live. Each arrives on its own motion
 * and idles on its own loop — and they are already peeking up under the
 * headline as it leaves, not waiting for the pin. Then the flanks tuck behind
 * the ticket and the ticket scales until its paper fills the viewport — and
 * that paper is the ground of "One call. We do the rest.", whose eyebrow and
 * headline rise inside it before the release (`config.handoff`, the same
 * string the section renders). The ticket becomes the page. The agentcy.co
 * shape (three tiles, then one fills the frame), on our material.
 *
 * Why the ticket and not the feed card: it is literally paper; its ground is
 * the page colour from the first frame, so the fill has nothing to blend and
 * cannot seam; and it is the one artefact of the whole system a cook actually
 * reads. The paper section that follows must be opaque from its top edge —
 * Statement.tsx, `handoff`.
 *
 * Mechanics live in opening.module.css. In short: the runway is a tall block
 * with a sticky 100svh stage; one custom property `--ssop-p` runs 0→1 across
 * it, written by a CSS scroll-driven animation where the browser has one and by
 * `useScrollProgress` where it does not; every tile reads it inside a transform
 * or an opacity and nothing else. Reduced motion never enters the runway at
 * all: the three tiles sit at rest on the colour field and the paper section
 * follows as a clean cut.
 *
 * The ground is `absolute inset-0 -z-10` inside a section that is `isolate`:
 * a layer filling this whole section, behind everything in it. A flat colour
 * scrolling with the page reads exactly like one held fixed, and the pair is
 * immune to whatever paints around the section. It used to be a FIXED `-z-10`
 * layer in the root stacking context, which only showed because the page
 * wrapper had no background; when the wrapper gained `bg-background`
 * (src/app/[client]/page.tsx, 2026-09-23) the whole opening went cream on the
 * live site. Do not go back to `fixed`: without the isolate it hides behind
 * the wrapper, and with it the fixed layer paints over every later section.
 *
 * `.accent-word` is overridden to inherit: it paints `var(--accent)`, which on
 * an accent ground would be an invisible word. The display italic is the whole
 * distinction here.
 */
export default function Opening({ config, site }: SectionProps<OpeningSection>) {
  const runway = useScrollProgress<HTMLDivElement>()
  const wordmark = `${site.name.toLowerCase()}${config.wordmarkSuffix ?? ''}`
  const lines = config.headline.split('\n')

  // The idle loops sit paused on their first frame until the runway's top
  // crosses the lower 40% of the viewport, then run from zero — so the feed
  // slides in as its tile arrives and the ticket prints as it rises, rather
  // than each loop being caught mid-cycle. One observer, one class, once.
  useEffect(() => {
    const el = runway.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        el.classList.add(s.live)
        observer.disconnect()
      },
      { rootMargin: '0px 0px -40% 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [runway])

  return (
    <section id="hero" className="relative isolate">
      <div aria-hidden className="grain absolute inset-0 -z-10 bg-accent" />

      <style>{`
        @keyframes ssop-rise { from { transform: translateY(110%); } to { transform: none; } }
        @keyframes ssop-fade { from { opacity: 0; } to { opacity: 1; } }
        .ssop-mask { display: block; overflow: hidden; padding-bottom: 0.06em; }
        .ssop-line { display: block; animation: ssop-rise 1.05s cubic-bezier(.16,1,.3,1) both; }
        .ssop-fade { animation: ssop-fade .8s ease-out both; }
        .ssop-head .accent-word { color: inherit; }
        @media (prefers-reduced-motion: reduce) {
          .ssop-line, .ssop-fade { animation: none; opacity: 1; transform: none; }
        }
      `}</style>

      {/* ---------------- screen one ---------------- */}
      <div className="flex min-h-[100svh] flex-col justify-center px-6 pb-[16vh] pt-28 sm:pb-[14vh] sm:pt-32">
        <div className="mx-auto w-full max-w-5xl">
          <p className="ssop-fade text-sm font-medium tracking-[0.02em] text-accent-foreground/75">{wordmark}</p>
          {/* No `text-balance`: the headline is already broken deliberately at
              the `\n`, and balancing each half again on a phone tapered the rag
              to two short trailing lines. Left to fill, it reads as a set block. */}
          <h1 className="ssop-head mt-8 text-pretty text-[2.1rem] font-bold leading-[1.04] tracking-[-0.035em] text-accent-foreground sm:mt-10 sm:text-5xl lg:text-7xl">
            {lines.map((line, i) => (
              <span key={i} className="ssop-mask">
                <span className="ssop-line" style={{ animationDelay: `${0.2 + i * 0.14}s` }}>
                  <AccentHeading as="span" text={line} />
                </span>
              </span>
            ))}
          </h1>
        </div>
      </div>

      {/* ---------------- the move ---------------- */}
      <div ref={runway} className={s.runway}>
        <p className="sr-only">
          Three moments from the operation, drawn in type: an order arriving on the kitchen feed, its ticket
          printing, and tonight’s special going live on the menu.
        </p>

        <div className={s.stage} aria-hidden>
          <div className={cn(s.tile, s.feed)}>
            <FeedTile />
            <p className={s.caption}>The order arrives</p>
          </div>

          <div className={cn(s.tile, s.ticket)}>
            <div className={s.zoom}>
              <TicketTile />
            </div>
            <p className={s.caption}>The ticket prints</p>
          </div>

          <div className={cn(s.tile, s.menu)}>
            <MenuTile />
            <p className={s.caption}>The menu goes live</p>
          </div>

          {/* The backing sheet: the same paper, behind everything, for whatever
              the scaled ticket has not covered by the release. */}
          <div className={s.paper} />

          {/* The next section's heading, painted early and rising inside the
              paper. A `<p>`: the real `<h2>` is in the section (screen-reader-
              only under motion), and this stage is aria-hidden. */}
          {config.handoff && (
            <div className={s.rise}>
              <PlainHeading as="p" eyebrow={config.handoff.eyebrow} title={config.handoff.headline} />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
