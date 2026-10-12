'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SectionProps, NavSection } from '@/lib/types'

export default function Nav({ config, brand, site }: SectionProps<NavSection>) {
  const [open, setOpen] = useState(false)
  // Overlay mode: transparent over the hero photo, solid once you scroll past it.
  const [scrolled, setScrolled] = useState(false)

  const overlay = config.overlay ?? false

  useEffect(() => {
    if (!overlay) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setScrolled(window.scrollY > window.innerHeight * 0.55))
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [overlay])

  const toHref = (link: string) => '#' + link.toLowerCase().replace(/\s+/g, '-')
  const items = config.links.map((l) => (typeof l === 'string' ? { label: l, href: toHref(l) } : l))

  // Overlay + not scrolled + menu closed → white-on-photo. Otherwise light bar.
  const onPhoto = overlay && !scrolled && !open

  return (
    <nav
      className={cn(
        'z-50 transition-[background-color,border-color,box-shadow] duration-500',
        overlay ? 'fixed inset-x-0 top-0' : 'sticky top-0',
        onPhoto
          ? 'border-b border-transparent bg-transparent'
          : 'border-b border-border/60 bg-background/85 backdrop-blur-md',
      )}
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Wordmark */}
          <a href="#hero" className="flex items-center gap-2.5">
            {brand.logo ? (
              <Image src={brand.logo} alt={site.name} width={36} height={36} className="h-9 w-auto object-contain" />
            ) : (
              <span className="h-6 w-1.5 rounded-full bg-accent" aria-hidden />
            )}
            <span
              className={cn(
                'text-base font-semibold tracking-tight transition-colors duration-500',
                onPhoto ? 'text-white' : 'text-foreground',
              )}
            >
              {site.name}
            </span>
          </a>

          {/* Desktop links */}
          <div className="hidden items-center gap-7 md:flex">
            {items.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className={cn(
                  'text-sm font-medium capitalize transition-colors duration-300',
                  onPhoto ? 'text-white/85 hover:text-white' : 'text-foreground/70 hover:text-accent',
                )}
              >
                {link.label}
              </a>
            ))}
            {config.cta && (
              <a
                href={config.cta.href}
                className={cn(
                  'inline-flex h-9 items-center rounded-full px-4 text-sm font-semibold shadow-sm transition-all hover:-translate-y-0.5',
                  onPhoto
                    ? 'bg-white/15 text-white ring-1 ring-inset ring-white/40 backdrop-blur-sm hover:bg-white/25'
                    : 'bg-accent text-accent-foreground hover:bg-accent/90',
                )}
              >
                {config.cta.label}
              </a>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className={cn('p-1 transition-colors duration-300 md:hidden', onPhoto ? 'text-white' : 'text-foreground')}
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            {open ? <X className="size-6" /> : <Menu className="size-6" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="flex flex-col gap-1 border-t border-border/60 bg-background px-4 py-3 md:hidden">
          {items.map((link) => (
            <a
              key={link.label}
              href={link.href}
              onClick={() => setOpen(false)}
              className="py-2 text-sm font-medium capitalize text-foreground/70 transition-colors hover:text-accent"
            >
              {link.label}
            </a>
          ))}
          {config.cta && (
            <a
              href={config.cta.href}
              onClick={() => setOpen(false)}
              className="mt-2 inline-flex h-10 items-center justify-center rounded-full bg-accent px-4 text-sm font-semibold text-accent-foreground"
            >
              {config.cta.label}
            </a>
          )}
        </div>
      )}
    </nav>
  )
}
