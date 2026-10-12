'use client'

import { useEffect, useRef } from 'react'

/**
 * The fallback driver for the opening's runway (see opening.module.css).
 *
 * Publishes an element's scroll progress as a custom property on itself — 0
 * when its top edge reaches the top of the viewport, 1 when its bottom edge
 * reaches the bottom — which is exactly the range the CSS scroll-driven
 * animation covers with `animation-range: contain 0% contain 100%`. The two
 * drivers are interchangeable, and this one steps aside whenever the browser
 * has the real thing.
 *
 * Rules it keeps:
 *
 * - Nothing downstream may touch layout. The value is an inherited unitless
 *   number, so descendants express themselves as `calc(var(--ssop-p) * 40vh)`
 *   inside a `transform`, or as an `opacity`. Never a width, a top, a margin.
 * - No React state. A scroll-driven value in state re-renders the tree sixty
 *   times a second; this writes one string to one element per frame.
 * - Reduced motion is a real branch: the listener is never attached, and the
 *   stylesheet renders its still composition without this hook's help.
 */
export function useScrollProgress<T extends HTMLElement = HTMLDivElement>(property = '--ssop-p') {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // The stylesheet drives it natively; a second writer would only fight it.
    if (typeof CSS !== 'undefined' && CSS.supports('animation-timeline', 'view()')) return

    let raf = 0
    const measure = () => {
      raf = 0
      const r = el.getBoundingClientRect()
      const range = r.height - window.innerHeight
      const p = range <= 0 ? 0 : Math.min(1, Math.max(0, -r.top / range))
      el.style.setProperty(property, p.toFixed(4))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
      el.style.removeProperty(property)
    }
  }, [property])

  return ref
}
