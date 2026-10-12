'use client'

import { useReveal } from '@/hooks/use-reveal'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SectionProps } from '@/lib/types'
import type { TiersSection } from '../types'
import PlainHeading from './PlainHeading'

/** One feature line. Shared by the bundle card and the tier cards. */
function Feature({ text }: { text: string }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-accent/70" />
      {text}
    </li>
  )
}

/** The price block: monthly big, one-time build under it. */
function Price({ monthly, setup, setupNote, big }: { monthly: string; setup: string; setupNote?: string; big?: boolean }) {
  return (
    <>
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'font-heading font-bold leading-none tracking-[-0.04em] text-foreground tabular-nums',
            big ? 'text-5xl sm:text-6xl' : 'text-4xl',
          )}
        >
          {monthly}
        </span>
        <span className="text-sm text-foreground/55">/ month</span>
      </div>
      <p className="mt-2 text-sm text-foreground/60">
        <span className="font-semibold text-foreground/80">{setup}</span> one-time build
        {setupNote && <> · {setupNote}</>}
      </p>
    </>
  )
}

/**
 * Overrides `pricing`. The prices are on the page on purpose: the incumbent we
 * are displacing hides them behind a "Request a Demo" wall, and publishing is
 * the cheapest way to look unlike them.
 *
 * The FEATURED tier is pulled out of the grid and set as one full-width card
 * above it, with its features in two columns. Two reasons: the bundle is the
 * product (Rohan, 2026-09-21) and should not be one of five equal boxes; and
 * five equal boxes do not divide — a 4-across grid left a single orphan card
 * on a second row at every wide width.
 *
 * One CTA under the whole grid, not one per card — identical filled buttons on
 * every card turn a grid into a wall of one colour (see motion-craft). The
 * cards carry hairlines; only the bundle takes the accent.
 */
export default function Tiers({ config }: SectionProps<TiersSection>) {
  const ref = useReveal()
  const bundle = config.tiers.find((t) => t.featured)
  const rest = config.tiers.filter((t) => t !== bundle)

  return (
    <section id={config.id} className="bg-background px-6 py-24 sm:py-32">
      <div ref={ref} className="reveal-item mx-auto max-w-6xl">
        <PlainHeading eyebrow={config.eyebrow} title={config.headline} intro={config.intro} />

        {bundle && (
          <div className="warm-lift mt-16 rounded-[var(--radius-xl)] border border-accent/60 bg-card p-7 shadow-[0_24px_50px_-38px_rgb(0_0_0/0.7)] sm:p-9">
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-12">
              <div>
                {/* The badge is a recommendation, not a popularity claim. We
                    have no clients yet, so "most take this" would be the same
                    invented traction the incumbent's fake reviews are. */}
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
                  <h3 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">{bundle.name}</h3>
                  <span className="rounded-full bg-accent px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-accent-foreground">
                    The one to start with
                  </span>
                </div>
                <div className="mt-6">
                  <Price monthly={bundle.monthly} setup={bundle.setup} setupNote={bundle.setupNote} big />
                </div>
                {bundle.summary && (
                  <p className="mt-5 text-base leading-relaxed text-foreground/65">{bundle.summary}</p>
                )}
              </div>
              <ul className="grid grid-cols-1 gap-3 border-t border-border pt-6 text-sm leading-relaxed text-foreground/70 sm:grid-cols-2 sm:gap-x-8 lg:border-l lg:border-t-0 lg:pl-12 lg:pt-0">
                {bundle.features.map((f) => (
                  <Feature key={f} text={f} />
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* grid-cols-1 is explicit: an implicit track sizes to max-content and
            runs off a phone. The three ways in go 1 / 3 across — two across
            would orphan the third card. */}
        <div className="stagger-children mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {rest.map((tier) => (
            <div
              key={tier.name}
              className="warm-lift flex flex-col rounded-[var(--radius-xl)] border border-border bg-card p-7 sm:p-8"
            >
              <h3 className="text-xl font-semibold tracking-[-0.02em] text-foreground">{tier.name}</h3>

              <div className="mt-6">
                <Price monthly={tier.monthly} setup={tier.setup} setupNote={tier.setupNote} />
              </div>

              {tier.summary && <p className="mt-5 text-sm leading-relaxed text-foreground/65">{tier.summary}</p>}

              <ul className="mt-6 space-y-3 border-t border-border pt-6 text-sm leading-relaxed text-foreground/70">
                {tier.features.map((f) => (
                  <Feature key={f} text={f} />
                ))}
              </ul>
            </div>
          ))}
        </div>

        {config.terms && (
          <ul className="mt-10 flex flex-col gap-2 text-sm text-foreground/55 sm:flex-row sm:flex-wrap sm:gap-x-8">
            {config.terms.map((t) => (
              <li key={t} className="flex gap-2">
                <span aria-hidden className="text-accent">
                  ✦
                </span>
                {t}
              </li>
            ))}
          </ul>
        )}

        {config.cta && (
          <div className="mt-12 text-center">
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
      </div>
    </section>
  )
}
