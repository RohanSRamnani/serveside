import type { ComponentType } from 'react'

export interface BrandConfig {
  primaryColor: string
  accentColor: string
  backgroundColor: string
  textColor: string
  font: string
  logo: string
}

export interface BusinessHours {
  day: string
  open?: string
  close?: string
  closed?: boolean
}

export interface BusinessConfig {
  address: string
  phone: string
  email: string
  website?: string
  googleMapsUrl?: string
  hours: BusinessHours[]
}

export interface SiteMeta {
  slug: string
  name: string
}

export interface SectionProps<T = unknown> {
  config: T
  brand: BrandConfig
  business: BusinessConfig
  site: SiteMeta
}

// A link is either a bare label (anchor derived by slugifying it) or an
// explicit {label, href} — real sites' nav labels rarely match our section ids,
// and mirroring a client's nav 1:1 needs the explicit form.
export type NavLink = string | { label: string; href: string }
export interface NavSection { type: 'nav'; links: NavLink[]; cta?: { label: string; href: string }; overlay?: boolean }
// backgroundVideo takes precedence over backgroundImage and reuses the same
// full-bleed treatment; set backgroundImage too — it is the poster frame, and
// the still is what shows on reduced-motion and slow connections.
export interface HeroSection { type: 'hero'; eyebrow?: string; headline: string; subheadline?: string; backgroundImage?: string; backgroundVideo?: string; cta?: { label: string; href: string }; secondaryCta?: { label: string; href: string } }
export interface ServicesSection { type: 'services'; headline: string; items: { name: string; price?: string; description?: string }[] }
export interface AboutSection { type: 'about'; headline: string; body: string; image?: string }
export interface ContactSection { type: 'contact'; eyebrow?: string; headline?: string; subtitle?: string; form?: { bookingUrl?: string; submitLabel?: string } }
export interface PricingSection { type: 'pricing'; headline: string; tiers: { name: string; price: string; features: string[] }[] }
export interface FooterSection { type: 'footer'; legal?: string }
export interface InquirySection { type: 'inquiry'; headline: string; subtitle?: string }

export type SectionConfig = NavSection | HeroSection | ServicesSection | AboutSection | ContactSection | PricingSection | FooterSection | InquirySection

export type SectionType = SectionConfig['type']

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous section registry: each section type has its own config shape
export type SectionOverrides = Partial<Record<SectionType, ComponentType<SectionProps<any>>>>

export interface ClientConfig {
  slug: string
  name: string
  tagline: string
  description: string
  stylePreset?: string
  hidden?: boolean
  /** Absolute-from-root path to a 1200×630 share image, e.g. `/clients/x/og.jpg`. */
  ogImage?: string
  brand?: Partial<BrandConfig>
  business: BusinessConfig
  sections: SectionConfig[]
  overrides?: SectionOverrides
}

export interface ResolvedClientConfig extends Omit<ClientConfig, 'brand'> {
  brand: BrandConfig
  theme?: { radius: string; headingFont: string; bodyFont: string }
}
