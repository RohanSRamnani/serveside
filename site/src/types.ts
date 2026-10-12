import type {
  AboutSection,
  ContactSection,
  InquirySection,
  HeroSection,
  PricingSection,
  ServicesSection,
} from '@/lib/types'

// Client-local extensions of the core section types (the hub-brooklyn pattern).
// Each one extends a core shape, so a typed const drops into `sections` with no
// cast, and the matching override component reads the extra fields. Nothing
// here is registered in resolve-sections.ts — the override map does the work.
//
// The product name lives in ONE place: the client config's `name`, which the
// renderer hands every section as `site.name`. No component below may hardcode
// it, because the name is still up for a rename.

/**
 * The opening: one solid colour field carrying the wordmark and the offer, and
 * nothing else on screen one — then, as you scroll, the site's signature move.
 *
 * Screen one replaced a drifting constellation of product screenshots that
 * zoomed one of them to full bleed — Rohan, 2026-09-21, on the live site: "I
 * don't know if I love the little snippets that are just randomly placed
 * throughout that first landing page… it can be cleaner, we can just make it
 * one colour honestly." Those screenshots, the caption and the price line are
 * gone, and so are the fields that fed them. Do not add imagery back to screen
 * one; the page carries no photography at all.
 *
 * The move that follows screen one is NOT imagery: three vignettes of the
 * operation built in type and colour from the fictional Marigold menu (an order
 * on the feed, its ticket printing, a special going live), which converge into
 * the ticket, which scales until its paper is the ground of the next section.
 * They take no config — every string in them lives with the component
 * (components/opening/), because none of it is copy to be edited per client.
 */
export interface OpeningSection extends HeroSection {
  /** Follows the wordmark, e.g. '™'. The word itself is `site.name`. */
  wordmarkSuffix?: string
  /**
   * The heading of the section the move lands on, painted early: it rises
   * inside the ticket's paper over the last stretch of the runway, so the
   * release carries it up with the page. MUST be the same object the section
   * itself renders — config.ts defines it once and hands it to both — because
   * this is that heading shown early, not a second one.
   */
  handoff?: { eyebrow?: string; headline: string }
}

export interface StatementItem {
  name: string
  description: string
}

/**
 * Plain statements in the agentcy register — one huge grotesk line with a single
 * accent word, then an index list that spells the claim out.
 * `clarity` = what we sell. `steps` = numbered how-it-works.
 */
export interface StatementSection extends AboutSection {
  /** Section anchor — must match the nav label slug ('What you get' -> 'what-you-get'). */
  id: string
  layout: 'clarity' | 'steps'
  eyebrow?: string
  items: StatementItem[]
  note?: string
  /** The funnel verb's first appearance in the body of the page. */
  cta?: { label: string; href: string }
  /**
   * Set on the section that FOLLOWS the opening, and only that one. The opening
   * ends with the kitchen ticket's paper filling the viewport, and this
   * section's ground is that same paper, opaque from its top edge, so the two
   * meet with no seam. See Opening.tsx, Statement.tsx and motion-craft,
   * "Leaving the hero should be one move, not two pages".
   */
  handoff?: boolean
}

export interface ProductRow {
  name: string
  description?: string
}

/**
 * The product, as an index list of outlined display rows that fill with accent
 * under the pointer. Typographic by decision: the example-storefront photography
 * that used to hang in a margin rail here left the sales path entirely on
 * 2026-09-21, and a one-colour opening followed by type-only product sections
 * is one look rather than two. The page carries no photography at all now —
 * see IMAGERY at the top of config.ts.
 */
export interface ProductIndexSection extends ServicesSection {
  id: string
  eyebrow?: string
  intro?: string
  items: ProductRow[]
  note?: string
}

export interface Tier {
  name: string
  /** Core PricingSection requires this; we render `setup` + `monthly` instead. */
  price: string
  setup: string
  /** Follows the setup price, e.g. the switching discount. */
  setupNote?: string
  monthly: string
  summary?: string
  features: string[]
  featured?: boolean
}

export interface TiersSection extends PricingSection {
  id: string
  eyebrow?: string
  intro?: string
  tiers: Tier[]
  /** Terms that apply across every tier. */
  terms?: string[]
  cta?: { label: string; href: string }
}

export type { InquirySection }

/**
 * The capture. A calendar, not a lead form — see BookCall.tsx.
 * `bookingUrl` is the single switch between the real embed and the placeholder.
 */
export interface BookCallSection extends ContactSection {
  /** Calendly-style inline embed URL. Unset renders the placeholder panel. */
  bookingUrl?: string
  /** Shown only while `bookingUrl` is unset, so the layout stays judgeable. */
  placeholder?: { title: string; body?: string; note?: string }
  /** Plain facts about what the call is. */
  points?: string[]
  note?: string
}
