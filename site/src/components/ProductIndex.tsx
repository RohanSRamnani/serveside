'use client'

import { useReveal } from '@/hooks/use-reveal'
import { cn } from '@/lib/utils'
import type { SectionProps } from '@/lib/types'
import type { ProductIndexSection } from '../types'
import PlainHeading from './PlainHeading'

/**
 * Overrides `services`, and renders the product index.
 *
 * Rows are solid display type on paper; the hovered row wipes full of accent
 * from the left and the type flips to the light ink over it. That is the whole
 * treatment — this section is typographic.
 *
 * Two things are deliberately NOT here any more:
 * - The OUTLINED rest state (`-webkit-text-stroke`, transparent fill), which
 *   Rohan called horrendous on the live site on 2026-09-21. He likes the hover,
 *   so the hover is untouched and only the rest state changed. Do not put
 *   hairline letterforms back.
 * - A photograph of the example storefront in a margin rail, plus a thumbnail
 *   per row under `lg`. Demo imagery left the sales path the same day, and the
 *   page shows no real client at all (IMAGERY, top of config.ts). If imagery
 *   ever earns a place in here, it returns as a rail — the deleted version is
 *   in git.
 *
 * Under `lg` there is no pointer, so no wipe: the rows are simply a list. The
 * audience is standing in a kitchen holding a phone; nothing here may depend on
 * hover.
 *
 * NEXT CHANGE ALREADY ASKED FOR: each row becomes clickable, opening a detail
 * view for that one piece. The hook is the single `<div>` wrapping each row's
 * content — swap it for an `<a href>` (or `<Link>`) and add `href` to
 * `ProductRow`. Nothing else in here needs to move.
 */
export default function ProductIndex({ config }: SectionProps<ProductIndexSection>) {
  const ref = useReveal()

  return (
    <section id={config.id} className="bg-background px-6 py-24 sm:py-32">
      <div ref={ref} className="reveal-item mx-auto max-w-5xl">
        <PlainHeading eyebrow={config.eyebrow} title={config.headline} intro={config.intro} />

        <ul className="mt-16 border-t border-border">
          {config.items.map((item) => (
            <li key={item.name} className="group relative isolate overflow-hidden border-b border-border">
              {/* The wipe. Transform-only, so it costs nothing to animate. */}
              <span
                aria-hidden
                className="absolute inset-0 -z-10 origin-left scale-x-0 bg-accent transition-transform duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none lg:group-hover:scale-x-100"
              />
              {/* Inset on hover is a transform, not padding — animating box
                  metrics would put layout on the hover path for nothing. */}
              <div className="flex items-start gap-5 py-6 transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none sm:gap-7 sm:py-7 lg:group-hover:translate-x-6">
                <div className="grid min-w-0 flex-1 grid-cols-1 items-baseline gap-x-10 gap-y-2 lg:grid-cols-[1.05fr_1.2fr]">
                  <h3
                    className={cn(
                      'text-xl font-bold leading-[1.1] tracking-[-0.025em] text-foreground transition-colors duration-500 sm:text-2xl',
                      // Solid ink at rest at every width — same treatment as
                      // the headlines. Only the hover changes it: the accent
                      // wipes in behind and the type flips to the light ink.
                      'lg:text-4xl lg:group-hover:text-accent-foreground',
                    )}
                  >
                    {item.name}
                  </h3>
                  {item.description && (
                    <p className="max-w-xl text-base leading-relaxed text-foreground/65 transition-colors duration-500 lg:group-hover:text-accent-foreground/85">
                      {item.description}
                    </p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>

        {config.note && <p className="mt-12 max-w-2xl text-sm leading-relaxed text-foreground/50">{config.note}</p>}
      </div>
    </section>
  )
}
