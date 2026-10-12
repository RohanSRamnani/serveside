'use client'

import { useReveal } from '@/hooks/use-reveal'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SectionProps } from '@/lib/types'
import type { StatementSection } from '../types'
import PlainHeading from './PlainHeading'
import s from './opening/opening.module.css'

/**
 * Overrides `about`, and renders both of this page's plain-statement beats:
 *
 * - `clarity` — the whole offer, one plain line per thing we do. This is the
 *   first thing a visitor reads after the colour field, and the section the
 *   brief hangs on: an owner reads the rows and knows what we run for them.
 *   No inference.
 * - `steps`   — the numbered how-it-works.
 *
 * Both use the index-list pattern: hairline rows, the claim set large on the
 * left, the plain-English detail on the right. One override renders every
 * `about` in the config; `layout` picks the variant.
 *
 * `handoff` is the other half of the opening's signature move. The opening
 * ends with the kitchen ticket scaled until its paper fills the viewport
 * (Opening.tsx), and this section's ground has to BE that paper: opaque page
 * colour from its very top edge, so the ticket's paper and the section's paper
 * meet as one surface with no seam — no gradient, no fade, nothing for a
 * scrollbar to catch on. (It used to be a transparent-to-paper gradient rising
 * over the colour field; the ticket's fill absorbed that job.)
 *
 * The heading rises INSIDE that paper, before the release: the opening paints
 * this section's eyebrow and headline in the stage's lower third over the last
 * 12% of the runway (Opening.tsx, `.rise`), from the same string — config.ts
 * defines it once and hands it to both. So while motion is on, this section's
 * own heading is screen-reader-only (the stage is aria-hidden, which leaves
 * exactly one heading exposed), its top padding is dropped so the first row
 * sits one gap under the risen heading, and `scroll-margin-top` makes the
 * `#what-we-do` anchor land with that heading under the nav. All of that is
 * the module's `handoff*` classes, which only apply under
 * `prefers-reduced-motion: no-preference`; the still composition keeps the
 * heading here with its normal padding, as before. Then the rows come down in
 * turn — the beat Rohan asked for ("the first thing they should get is
 * everything we built for you… that should smoothly come down").
 */
export default function Statement({ config }: SectionProps<StatementSection>) {
  const ref = useReveal()
  // The rows carry their own reveal so they can arrive in sequence. The
  // observer above would flip them all at once; the per-row delay is what makes
  // it a cascade rather than a jump. (useReveal also reveals nested reveal-*
  // descendants, so this list would move even without an observer of its own —
  // it keeps one so the rows still cascade when the heading is already read.)
  const list = useReveal<HTMLUListElement>()
  const steps = config.layout === 'steps'

  return (
    <section
      id={config.id}
      className={cn(
        'relative bg-background px-6',
        config.handoff ? cn('pb-24 pt-20 sm:pb-32 sm:pt-28', s.handoffSection) : 'py-24 sm:py-32',
      )}
    >
      <div ref={ref} className="reveal-item relative mx-auto max-w-5xl">
        <div className={config.handoff ? s.handoffHeading : undefined}>
          <PlainHeading eyebrow={config.eyebrow} title={config.headline} />
        </div>

        {/* ROWS BEFORE PROSE, deliberately. The body used to sit between the
            heading and the list, which put ten lines of centred paragraph
            between the visitor and the rows — on a phone the first row landed
            a screen and a half down. The rows are the pitch; the prose is the
            argument for them, so it reads afterwards.

            Each row's content sits in ONE wrapper div inside the `li`, not
            directly in it. That is the hook for the change already asked for:
            a row becomes clickable by swapping that div for an `<a href>` and
            adding `href` to `StatementItem`. Nothing else has to move. */}
        <ul ref={list} className={cn('mt-14 border-t border-border sm:mt-16', config.handoff && s.handoffList)}>
          {config.items.map((item, i) => (
            <li
              key={item.name}
              className="reveal-item border-b border-border"
              style={{ transitionDelay: `${i * 110}ms` }}
            >
              <div className="grid grid-cols-1 gap-x-10 gap-y-2 py-7 sm:grid-cols-[1.1fr_1.3fr] sm:items-baseline sm:py-8">
                <div className="flex items-baseline gap-4">
                  <span
                    aria-hidden
                    className={cn(
                      'shrink-0 font-heading text-sm tabular-nums text-accent',
                      !steps && 'text-base',
                    )}
                  >
                    {steps ? String(i + 1).padStart(2, '0') : '≈'}
                  </span>
                  <h3 className="text-2xl font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-3xl">
                    {item.name}
                  </h3>
                </div>
                <p className="pl-8 text-base leading-relaxed text-foreground/65 sm:pl-0">{item.description}</p>
              </div>
            </li>
          ))}
        </ul>

        {config.body && (
          // Left-aligned on a phone: two centred paragraphs of six lines each
          // is a wall of ragged text at 390px, and the phone is where the
          // clutter complaints came from.
          <div className="mx-auto mt-14 max-w-2xl space-y-5 text-lg leading-relaxed text-foreground/65 sm:text-center">
            {config.body.split('\n\n').map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        )}

        {config.cta && (
          <div className="mt-14 text-center">
            <a
              href={config.cta.href}
              className={cn(
                buttonVariants({ size: 'lg' }),
                'press h-13 rounded-full bg-accent px-8 text-base font-semibold text-accent-foreground shadow-sm hover:bg-accent/90',
              )}
            >
              {config.cta.label}
            </a>
          </div>
        )}

        {config.note && (
          <p className="mt-10 text-center text-sm leading-relaxed text-foreground/50">{config.note}</p>
        )}
      </div>
    </section>
  )
}
