'use client'

import { useEffect, useRef } from 'react'

const NESTED_REVEALS = '.reveal-item, .reveal-left, .reveal-right, .reveal-scale, .reveal-blur'

export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const setRevealed = (on: boolean) => {
      // The observed element AND any nested reveal-* descendants — they carry
      // the same opacity-0 initial state but have no observer of their own.
      // Missing them leaves whole columns invisible.
      const targets = [el, ...el.querySelectorAll(NESTED_REVEALS)]
      targets.forEach((t) => t.classList.toggle('revealed', on))
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        if (entry.isIntersecting) {
          setRevealed(true)
        } else if (entry.boundingClientRect.top > 0) {
          // Fully below the viewport again (user scrolled back up past it):
          // re-arm so the reveal replays on the way down. Sections that exit
          // above (already read) stay revealed.
          setRevealed(false)
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -8% 0px' }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return ref
}
