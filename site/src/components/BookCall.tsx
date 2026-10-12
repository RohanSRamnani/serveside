'use client'

import { useEffect, useRef, useState } from 'react'
import Script from 'next/script'
import { useReveal } from '@/hooks/use-reveal'
import { cn } from '@/lib/utils'
import type { SectionProps } from '@/lib/types'
import type { BookCallSection } from '../types'
import PlainHeading from './PlainHeading'

const CALENDLY_WIDGET = 'https://assets.calendly.com/assets/external/widget.js'

interface CalendlyGlobal {
  initInlineWidget?: (opts: { url: string; parentElement: HTMLElement }) => void
}

/** Shown until the calendar has actually painted, and left in place if it never does. */
function Placeholder({ config }: { config: BookCallSection }) {
  return (
    <div className="flex h-full min-h-[26rem] flex-col items-center justify-center rounded-[var(--radius-xl)] border border-dashed border-accent/45 bg-background px-8 py-16 text-center">
      <span aria-hidden className="text-2xl text-accent">
        ✦
      </span>
      <p className="mt-6 text-2xl font-bold tracking-[-0.02em] text-foreground sm:text-3xl">
        {config.placeholder?.title ?? 'Book a call'}
      </p>
      {config.placeholder?.body && (
        <p className="mt-4 max-w-md text-base leading-relaxed text-foreground/65">{config.placeholder.body}</p>
      )}
      {config.bookingUrl ? (
        <a
          href={config.bookingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="press mt-8 inline-flex h-11 items-center rounded-full bg-accent px-6 text-sm font-semibold text-accent-foreground hover:bg-accent/90"
        >
          Open the calendar
        </a>
      ) : (
        <p className="mt-10 text-[11px] uppercase tracking-[0.22em] text-foreground/40">
          {config.placeholder?.note ?? 'Calendar embed drops in here'}
        </p>
      )}
    </div>
  )
}

/**
 * Overrides `contact`. The single capture on the page and the target of the one
 * funnel verb — nav pill, opening, product and pricing all land on #contact.
 *
 * It is a calendar, not a lead form. A name/email/phone form is a promise that
 * somebody will get back to you; a calendar is the meeting. Calendly emails the
 * owner natively, so there is nothing to automate on our side.
 *
 * `bookingUrl` is the only switch, and the fallback is real rather than
 * decorative: the placeholder panel is server-rendered and sits on top of the
 * widget slot until an actual `<iframe>` appears inside it. So a blocked
 * script, a failed load, or no JavaScript at all still leaves a designed panel
 * with a working link to the same calendar — never an empty rectangle.
 */
export default function BookCall({ config }: SectionProps<BookCallSection>) {
  const ref = useReveal()
  const slot = useRef<HTMLDivElement>(null)
  const [scriptReady, setScriptReady] = useState(false)
  const [embedded, setEmbedded] = useState(false)

  // Calendly reads brand colours off the query string, so the embed arrives in
  // this page's palette instead of its own blue.
  const embedUrl = config.bookingUrl
    ? `${config.bookingUrl}${config.bookingUrl.includes('?') ? '&' : '?'}hide_gdpr_banner=1&background_color=f7f0e1&text_color=1a1613&primary_color=ae3f06`
    : undefined

  // We mount the widget ourselves rather than using Calendly's auto-init on a
  // `.calendly-inline-widget[data-url]` element. Their script scans and mutates
  // matching nodes as soon as it loads, which raced React and produced a
  // hydration mismatch ("a tree hydrated but some attributes… didn't match").
  // Handing it an empty div after mount removes the race entirely.
  useEffect(() => {
    if (!embedUrl || !scriptReady) return
    const el = slot.current
    if (!el || el.childElementCount > 0) return
    const calendly = (window as unknown as { Calendly?: CalendlyGlobal }).Calendly
    calendly?.initInlineWidget?.({ url: embedUrl, parentElement: el })
  }, [embedUrl, scriptReady])

  // Proof of paint, not proof of download: the script loading does not mean
  // Calendly managed to render anything. The placeholder stays until an actual
  // iframe exists.
  useEffect(() => {
    if (!embedUrl) return
    const el = slot.current
    if (!el) return
    const painted = () => {
      if (!el.querySelector('iframe')) return false
      setEmbedded(true)
      return true
    }
    if (painted()) return
    const mo = new MutationObserver(() => {
      if (painted()) mo.disconnect()
    })
    mo.observe(el, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [embedUrl])

  return (
    <section id="contact" className="bg-muted px-6 py-24 sm:py-32">
      <div ref={ref} className="reveal-item mx-auto max-w-3xl">
        <PlainHeading eyebrow={config.eyebrow} title={config.headline ?? 'Book a call'} intro={config.subtitle} />

        {config.points && (
          <ul className="mx-auto mt-10 flex max-w-lg flex-col gap-3 text-sm text-foreground/60">
            {config.points.map((p) => (
              <li key={p} className="flex gap-3">
                <span aria-hidden className="text-accent">
                  ✦
                </span>
                {p}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-12">
          {embedUrl ? (
            // Calendly's inline widget takes the height you give it and clips
            // rather than growing. 700px is their documented minimum and it is
            // not enough: at that height the timezone row falls off the bottom
            // at both widths. Measured tall enough to show the whole month view
            // plus the timezone picker.
            <div className="relative min-h-[54rem] sm:min-h-[50rem]">
              {/* The widget measures the slot's width on init, so the slot is
                  always laid out — the placeholder covers it rather than
                  replacing it. */}
              <div
                ref={slot}
                className={cn(
                  'h-[54rem] w-full overflow-hidden rounded-[var(--radius-xl)] sm:h-[50rem]',
                  embedded && 'border border-border bg-background',
                )}
              />
              {!embedded && (
                <div className="absolute inset-0">
                  <Placeholder config={config} />
                </div>
              )}
              <Script
                src={CALENDLY_WIDGET}
                strategy="afterInteractive"
                onReady={() => setScriptReady(true)}
              />
            </div>
          ) : (
            <Placeholder config={config} />
          )}
        </div>

        {config.note && <p className="mt-8 text-center text-xs leading-relaxed text-foreground/45">{config.note}</p>}
      </div>
    </section>
  )
}
