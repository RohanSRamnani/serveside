'use client'

import AccentHeading from '@/components/AccentHeading'
import { cn } from '@/lib/utils'

interface PlainHeadingProps {
  /** Small tracked label. Lead it with an ornament glyph only where it earns one. */
  eyebrow?: string
  /**
   * One {braced} word takes the accent italic. Never more than one.
   * A `\n` is an explicit line break, for the titles that are two sentences —
   * "One call.\nWe do the rest." Left to `text-balance` a phone broke that one
   * after "We", which reads as a mistake.
   */
  title: string
  intro?: string
  align?: 'center' | 'left'
  className?: string
  /**
   * `h2` by default. `p` is for a purely visual copy of a heading that exists
   * elsewhere in the document — the opening's risen "One call. We do the rest."
   * is the section's heading painted early, not a second heading.
   */
  as?: 'h2' | 'p'
}

/**
 * The house rhythm for this site: eyebrow -> huge grotesk statement with a
 * single accent word -> one unhurried paragraph.
 *
 * It is `SectionHeading` re-set for this page rather than the shared one: the
 * reference register wants the statement much larger, tighter and often
 * centred, and wants the accent word, which the shared heading has no slot for.
 */
export default function PlainHeading({
  eyebrow,
  title,
  intro,
  align = 'center',
  className,
  as = 'h2',
}: PlainHeadingProps) {
  const centered = align === 'center'

  return (
    <div className={cn(centered ? 'mx-auto max-w-4xl text-center' : 'max-w-3xl text-left', className)}>
      {eyebrow && (
        <p
          className={cn(
            'mb-6 text-[11px] font-semibold uppercase tracking-[0.3em] text-accent',
            centered && 'flex items-center justify-center gap-3',
          )}
        >
          {eyebrow}
        </p>
      )}
      <AccentHeading
        as={as}
        text={title}
        className={cn(
          'text-balance text-4xl font-bold leading-[1.03] tracking-[-0.03em] text-foreground sm:text-5xl md:text-6xl',
          title.includes('\n') && 'whitespace-pre-line',
        )}
      />
      {intro && (
        <p
          className={cn(
            'mt-7 text-lg leading-relaxed text-foreground/65 sm:text-xl',
            centered ? 'mx-auto max-w-2xl' : 'max-w-2xl',
          )}
        >
          {intro}
        </p>
      )}
    </div>
  )
}
