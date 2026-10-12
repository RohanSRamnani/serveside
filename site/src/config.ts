import type { ClientConfig } from '@/lib/types'
import type {
  BookCallSection,
  InquirySection,
  OpeningSection,
  ProductIndexSection,
  StatementSection,
  TiersSection,
} from './types'
import Opening from './components/Opening'
import Statement from './components/Statement'
import ProductIndex from './components/ProductIndex'
import Tiers from './components/Tiers'
import BookCall from './components/BookCall'
import InquiryForm from './components/InquiryForm'

// =============================================================================
// Our own product site. Audience: NYC restaurant owners, Staten Island pizzeria
// through Brooklyn fine dining. B2B.
//
// THE NAME LIVES HERE AND ONLY HERE. `name` is handed to every section as
// `site.name`, and every string below that needs it builds it from NAME — so a
// rename stays a one-line edit. (It has already earned that once: this was
// "Supper" until Rohan settled on Serveside mid-build, and the only edits were
// in this file plus the two directory names.) If you are adding copy and about
// to type the product's name, interpolate instead.
//
// The name is also the position: serveside = our side of the pass is the
// restaurant's side. Said once, in the manifesto. Do not belabour it.
//
// IMAGERY: none. Everything on this page is type on paper or type on colour.
//   - Rohan, 2026-09-21, reviewing the live site: the screenshots scattered
//     through the opening read as clutter ("we can just make it one colour
//     honestly"). If imagery ever returns above the fold, it does not return
//     as a mosaic.
//   - Rohan, 2026-09-23: every trace of the Kashi pilot came off the site —
//     the client-work section under the calendar, its screenshots, and the
//     Kashi dishes and order in the opening's vignettes. NO REAL CLIENT appears
//     on this page — not a name, a dish, an order or a screenshot — until Rohan
//     says one may. Example content comes from the fictional `/marigold`
//     storefront, which exists so the product story never leans on a real
//     restaurant.
//
// VOICE, enforced throughout: plain, one business owner to another. Rohan
// rejected an earlier pass as "Claude speak" and named the tic — copy that
// frames itself ("everything we build you, in four lines", "in plain English")
// instead of just saying the thing. Do not count the points, do not describe
// the copy, and prefer the shorter ordinary sentence to the crafted one.
//
// HONESTY RULES, enforced throughout:
//   - No testimonials. We have no clients who have given one. The thing we are
//     displacing publishes invented five-star reviews and "1200+ Global Happy
//     Clients" against 75 live tenants; our whole position is being checkable.
//   - Every screenshot is a screenshot. Nothing on this page is a mockup.
//   - The marketing services are described in capability language only. No
//     rankings, no traffic numbers, no "results": we have none worth citing
//     yet, and inventing them is precisely what we are selling against.
//   - Anything unbuilt says so where it appears. The AI phone host is a
//     "coming for founding restaurants" line in the list, the product index and
//     the bundle, and it is never described as answering calls today.
//   - The phase-1 owner tools (numbers, menu editor, 86 and pause, hours,
//     refunds, coupons, rewards, customer export, order and monthly emails),
//     ordering on the restaurant's own address, per-restaurant light/dark,
//     delivery and the chatbot are all "coming" until they ship. Flip each
//     line when its code is live, not before.
//   - Never name a competitor on this page (Rohan, 2026-10-12).
//   - Pricing is published rather than walled, and the recommended-tier badge
//     recommends rather than claiming traction we do not have.
// =============================================================================

const NAME = 'Serveside'
/** ONE VERB through the whole funnel: nav pill, opening, product, pricing, capture. */
const VERB = 'Book a call'
const CAPTURE = '#contact'

const P = '/clients/serveside'

// The opening: one solid paprika field, the wordmark, the offer. Nothing else
// on screen one. The `\n` is a deliberate break — each chunk is masked and
// rises on load, and each wraps freely below it, so the break is the only
// typography decision here and it survives every width. See Opening.tsx.
//
// What follows screen one on scroll — three vignettes of the operation that
// converge into the kitchen ticket, which scales until its paper becomes the
// next section's ground — takes no config of its own. Every string in it is
// example data from the fictional Marigold menu (never a real client's) and
// lives with the component (components/opening/). The one thing it borrows is
// the heading it lands on, `handoff`, which is the SAME object `whatWeDo`
// renders — see WHAT_WE_DO_HEADING.
//
// ONE COPY of the heading the move lands on. The opening paints it early,
// rising inside the ticket's paper; the section renders it for real (screen-
// reader-only while motion is on). Two references, one string.
const WHAT_WE_DO_HEADING = {
  eyebrow: '✦ What we do',
  // The `\n` breaks it at the full stop; see PlainHeading.
  headline: 'One call.\nWe do the {rest}.',
}

const opening: OpeningSection = {
  type: 'hero',
  wordmarkSuffix: '™',
  headline: 'Websites, ordering and marketing for restaurants —\nbuilt to look like {yours}.',
  handoff: WHAT_WE_DO_HEADING,
}

// The first thing after the colour field, and the section the whole page hangs
// on. `handoff` makes its ground the same paper the opening's ticket fills the
// screen with, opaque from the top edge, so the opening's move lands here with
// no seam (Opening.tsx, Statement.tsx); the rows then come down in sequence.
//
// SPINE: operation first, storefront late. Rohan, 2026-09-21: "our main selling
// point here isn't even the site. It's the automation, it's the setting it up,
// end-to-end restaurant ordering, all the ordering systems in the back." So the
// order is kitchen → speed → menu → money → page → the rest, and the body sells
// the job we run rather than the page we design. Do not reorder these back.
//
// VOICE: plain, one business owner to another. Rohan called an earlier pass
// "Claude speak" and named the tic: copy that frames itself ("…in four lines",
// "…in plain English") instead of just saying the thing. No meta-framing, no
// counting the points, shorter and more ordinary sentences.
//
// The headline is Rohan's own line, and the list has to earn the second half of
// it: the first row is the one call, everything under it is "the rest".
const whatWeDo: StatementSection = {
  type: 'about',
  id: 'what-we-do',
  layout: 'clarity',
  handoff: true,
  eyebrow: WHAT_WE_DO_HEADING.eyebrow,
  headline: WHAT_WE_DO_HEADING.headline,
  body:
    'Ordering is not a page, it is a job. Somebody has to catch the order, get it to the line, take the special off when the fish runs out, and make sure the money lands in your account. The platforms do that job badly and take a cut of every ticket for it.' +
    '\n\n' +
    'We do the job, and we keep doing it after launch — the kitchen feed, the menu, the payments, and the page itself. What you touch is a tablet that chimes and an email address to send changes to. The platforms sit on their own side of the table; we sit on yours, which is where the name comes from.',
  items: [
    {
      // FIRST on purpose: it is the "one call" in the headline, so the title
      // and the list read as one thought. Rohan wants this story featured —
      // thirty minutes on a call, your input or your own designs, we write the
      // spec, live in two days.
      // "48 hours" is true for the site only. Ordering takes longer (Stripe,
      // the menu, the texting carrier), so it gets its own honest number.
      name: 'One call, your site in 48 hours',
      description:
        'Thirty minutes on a call. Bring designs you like or just tell us what you want, and we write it up. Your site in 48 hours. Ordering live in under two weeks.',
    },
    {
      name: 'Orders land in your kitchen',
      description:
        'A live order feed on your tablet. New orders chime until someone accepts them, and every order is texted to you as well. No POS needed.',
    },
    {
      name: 'We build the menu for you',
      description:
        'Every dish photographed, described and allergen-tagged. Email us a photo of tonight’s special and it is live the same day.',
    },
    {
      name: 'Flat monthly, 0% commission',
      description:
        'One price a month, whatever you sell. Payments settle straight into your bank — you are the merchant of record — and the customer list is yours. Card fees are Stripe’s, paid to Stripe directly.',
    },
    {
      name: 'Your own storefront',
      description:
        'Built out of your food, your room and your sign. Already have a domain? We put the new site on it and handle the DNS — the domain stays yours. Ordering on your own address, order.your-restaurant.com, is coming.',
    },
    {
      // The breadth line. It is also where the old standalone AI SEO section
      // went: Rohan wanted it "more integrated and kind of organized" rather
      // than a page that stacks one section per service. The detail lives in
      // the product index; this line is just the shape of the offer.
      // The phone agent keeps its "coming" qualifier — it is a pricing tier
      // marked coming, and this page does not describe unbuilt things as live.
      name: 'We can run the rest of your marketing',
      description:
        'Getting you found on Google, review responses, and paid ads when you want a push. A chatbot for your site is coming, and so is an AI agent for your phone line, for founding restaurants first. Add any of it when you are ready.',
    },
  ],
  cta: { label: VERB, href: CAPTURE },
}

// Typographic, by decision. Every row used to carry a frame of the example
// storefront — a photograph in the margin on desktop, a thumbnail per row on a
// phone. All of it came out on 2026-09-21: demo imagery left the sales path,
// and outlined display rows on paper is the same look as the colour field above
// rather than a second one.
// The detail layer under "One call. We do the rest." — this is what the rest
// actually is, piece by piece.
const product: ProductIndexSection = {
  type: 'services',
  id: 'product',
  eyebrow: '✦ The product',
  headline: 'Every {part} of it.',
  intro: 'No modules, no add-ons, no tiers hidden inside tiers. This is the whole thing.',
  items: [
    {
      name: 'The ordering storefront',
      description:
        'Sticky category chips, photographed dishes, the descriptions your kitchen already wrote, allergen tags on every plate. Cart, tax, total, pickup. Delivery is coming.',
    },
    {
      name: 'Light or dark, from your own look',
      description:
        'Coming: a bright room gets a bright storefront; a dinner-service dining room gets a dark one. We set it from your sign, your walls and your plates — not from a template default.',
    },
    {
      // No hardware promise on this site: Rohan pulled "we ship a tablet and a
      // printer" on 2026-09-21 and the hardware model is still his open
      // question. Describe what runs on the tablet they already own.
      name: 'The kitchen feed',
      description:
        'Runs in a browser on the tablet you already own. New orders chime until someone accepts them, and every order is texted to you too. No POS needed and nothing to integrate.',
    },
    // The phase-1 owner tools. Each is "coming" until its checkpoint ships;
    // flip the word, not the row, when it does.
    {
      name: 'Your numbers',
      description:
        'Coming: today’s orders and sales, your best-sellers, sales by day, and stats on every dish right on your menu. An email for each order, and a report in your inbox on the first of the month.',
    },
    {
      name: 'Your controls',
      description:
        'Coming: edit the menu and its photos yourself, 86 a dish or pause ordering in two taps, set your hours and holiday closures, refund an order, run coupons and rewards, and export your customer list.',
    },
    {
      name: 'We keep the menu',
      description:
        'Price change, new special, seasonal swap — email us a photo. It is live the same day. Maintaining the menu is our job, not yours.',
    },
    // ---- The marketing services, folded in from the old standalone AI SEO
    // section (Rohan, 2026-09-21: "let's make it more integrated and kind of
    // organized"). One list of everything we run beats a page that stacks a
    // section per service. Capability language only: what we do, never what it
    // will earn you — see `note` below.
    {
      name: 'Getting you found on Google',
      description:
        'A page for the neighborhood and a page for the dishes people search for, written from your real menu. Your Google profile kept current — hours, closures, photos, the order button. Reviews answered in your voice, including the ones you would rather not read.',
    },
    // AI SEO is off the price sheet until we have measured proof. Free test only.
    {
      name: 'Showing up in AI search',
      description:
        'Free AI search test for our first three restaurants — we measure where you show up before and after.',
    },
    {
      name: 'The phone, the chat and the ads',
      description:
        'Paid ads when you want a push. Coming: a chatbot on your site for the questions you answer twenty times a day, and an AI agent for your phone line, for founding restaurants.',
    },
  ],
  note:
    'No rankings promised and no traffic numbers quoted. We have not been doing this long enough to have honest ones, and invented ones are the reason this page exists.',
}

const howItWorks: StatementSection = {
  type: 'about',
  id: 'how-it-works',
  layout: 'steps',
  eyebrow: '✦ How it works',
  headline: 'Three steps, and one is {already} done.',
  body: '',
  items: [
    {
      name: 'We build your demo first',
      description:
        'Before we ever call you. You react to something real with your own food on it, not to a slide deck and a discovery call.',
    },
    {
      // Rohan likes these three steps as they are, so this is the only change:
      // the call he wants featured is named here too, because the sequence
      // otherwise jumped from the demo straight to a built menu.
      name: 'One call, then we build',
      description:
        'Thirty minutes to hear what you want — bring designs you like if you have them — and we write it up. Then we photograph the gaps, write the descriptions that are missing, load every price and tag every allergen.',
    },
    {
      name: 'Go live',
      description:
        'Your site goes up on your own domain, and your Google “Order Online” button points at your page instead of a marketplace.',
    },
  ],
}

// RATE CARD, locked with Rohan 2026-10-10 (plans/serveside-offer-and-phase-1.md,
// "The offer"). Setup is the same on every tier: the build labour is the same.
// The switching price is for anyone leaving another ordering provider — never
// name the provider (Rohan, 2026-10-12).
//
// The bundle is the product, so it is the featured tier and Tiers.tsx renders it
// as a full-width card above the others.
//
// The phone host keeps its "coming for founding restaurants" qualifier
// everywhere it appears, including inside the bundle. Its "unlimited" is
// unlimited for normal use, and the fair-use rule is said on the card, not in a
// footnote. AI SEO is not on this sheet: it is a free test for the first three
// restaurants (the product index) until we have measured proof.
//
// The card-fee rate is Stripe's published US online card rate, read off
// stripe.com/pricing on 2026-10-12. Re-check it before any price change.
const SETUP = '$1,000'
const SETUP_SWITCHING = '$499 if you’re switching from another ordering provider'
const PHONE_COMING = 'coming for founding restaurants'

const pricing: TiersSection = {
  type: 'pricing',
  id: 'pricing',
  eyebrow: '✦ Pricing',
  headline: 'Here is what it {costs}.',
  intro:
    'No “request a demo” wall, no quote hidden behind a call. Month-to-month after launch, and no commission on any tier, ever.',
  tiers: [
    {
      name: 'Everything',
      price: '$599',
      setup: SETUP,
      setupNote: SETUP_SWITCHING,
      monthly: '$599',
      featured: true,
      summary: `The site, online ordering and the AI phone host, for one price. The phone host is ${PHONE_COMING}.`,
      features: [
        'Everything in Site + Ordering',
        'Kitchen feed on your own tablet',
        'We build and maintain the whole menu',
        `AI phone host, unlimited for normal use — ${PHONE_COMING}`,
        '0% commission — payments settle to your bank',
        'Month-to-month after launch',
      ],
    },
    {
      name: 'Site',
      price: '$99',
      setup: SETUP,
      setupNote: SETUP_SWITCHING,
      monthly: '$99',
      summary: 'A site that looks like your restaurant. No ordering. Live in 48 hours.',
      features: [
        'Designed from your own photography',
        'Menu, hours, story, directions',
        'We keep it updated — email us the change',
        'Your domain, your content',
      ],
    },
    {
      name: 'Site + Ordering',
      price: '$299',
      setup: SETUP,
      setupNote: SETUP_SWITCHING,
      monthly: '$299',
      summary: 'The site and online ordering for pickup. Ordering live in under two weeks.',
      features: [
        'Everything in Site',
        'Ordering page for pickup — delivery coming',
        'Kitchen feed on your own tablet',
        'We build and maintain the whole menu',
        'Your numbers and owner controls — coming',
        '0% commission — payments settle to your bank',
      ],
    },
    {
      name: 'AI Phone Host',
      price: '$359',
      setup: SETUP,
      setupNote: SETUP_SWITCHING,
      monthly: '$359',
      summary: `Adds to any tier, ${PHONE_COMING}. Unlimited for normal use. Fair use applies: if your line runs far past a busy restaurant’s calls, we talk to you before anything changes.`,
      features: [
        'Answers the line you already have',
        'Takes orders and texts a payment link',
        'Passes allergy questions to a person',
        'Coming for founding restaurants',
      ],
    },
  ],
  terms: [
    '+$99/mo per extra location',
    'Annual prepay: two months free',
    'No commission on any tier, ever',
    'Month-to-month after launch',
    'Card fees are Stripe’s (2.9% + 30¢ per online card payment in the US), paid to Stripe directly',
  ],
  cta: { label: VERB, href: CAPTURE },
}

// The capture. A calendar first; Calendly emails Rohan natively, so
// there is nothing to automate here. The placeholder below is not dead code:
// it is what renders if the widget script is blocked or never paints.
const bookCall: BookCallSection = {
  type: 'contact',
  eyebrow: '✦ Start here',
  headline: VERB,
  subtitle:
    'Thirty minutes. Tell us the restaurant’s name and the neighborhood, and we will have built your demo before we get on the call.',
  points: [
    'We build the demo before the call, not after it.',
    'Flat monthly. No commission, on any tier, ever.',
    'Month-to-month after launch.',
  ],
  bookingUrl: 'https://calendly.com/rohansramnani/30min',
  placeholder: {
    title: 'Book a call',
    body: 'Thirty minutes, your demo already built. Pick a slot that suits service.',
  },
}

// The second way in, under the calendar, for an owner who would rather write
// than book. Sends to LEAD_TO_EMAIL through Resend (app/actions/inquiry.ts).
const inquiry: InquirySection = {
  type: 'inquiry',
  headline: 'Prefer email? Tell us about the restaurant.',
  subtitle: 'We reply by email, usually with your demo already built.',
}

const config: ClientConfig = {
  slug: 'serveside',
  name: NAME,
  tagline: 'Direct online ordering for restaurants',
  description: `Direct online ordering that looks like your restaurant. Your own storefront, a live kitchen feed, and we build the menu for you. Flat monthly, 0% commission.`,
  // `counter` for its grotesk headings, generous radius and warm ground — then
  // reground and re-accented below. Not a new preset: the preset list is
  // asserted in src/styles/__tests__/presets.test.ts and this look is one
  // client, not a house style. See the brand note.
  stylePreset: 'counter',
  brand: {
    // Warm paper, a long way from the reference build's near-white pink and a
    // long way from a SaaS template's white.
    backgroundColor: '#f7f0e1',
    // Sampled, not picked. Mean of the darkest saturated sauce pixels across
    // eight Kashi dish photographs (butter chicken, dal makhani, osso buco,
    // paneer butter masala, hot wings, sweet chilli cauliflower, methi murgh,
    // kadhai chicken): oklch(0.515 0.157 41) — paprika / chilli oil.
    // For the record, agentcy.co's orange measures #ec5928, oklch(0.652 0.191
    // 37.7): same corner of the wheel, far brighter and far more saturated.
    // Ours reads as the inside of a pan; theirs reads as a traffic cone.
    accentColor: '#ae3f06',
  },
  // LIVE. This is our own site, on our own domain (serveside.co, mapped in
  // src/lib/domains.ts and served at that domain's root by src/proxy.ts), so it
  // is the one client in the repo that is meant to be indexed. Every prospect
  // demo stays `hidden: true` — the robots noindex in src/app/[client]/page.tsx
  // keys off exactly this flag.
  hidden: false,
  ogImage: `${P}/og.jpg`,
  // GAP for Rohan: this business has no published address, phone or email yet.
  // Rather than invent them, the page carries none: the calendar and the
  // inquiry form are the ways in. Fill these in and the footer picks the
  // address up itself.
  business: { address: '', phone: '', email: '', hours: [] },
  overrides: {
    hero: Opening,
    about: Statement,
    services: ProductIndex,
    pricing: Tiers,
    contact: BookCall,
    inquiry: InquiryForm,
  },
  // ORDER: the offer, then the operation, then the price, then the call, and
  // the call is the last thing before the footer (see IMAGERY at the top).
  // `whatWeDo` must stay immediately after the opening: it carries `handoff`,
  // which makes its ground the paper the opening's ticket zooms into.
  // Dropped along the way: the standalone AI SEO section (folded into the
  // product index and the what-we-do list), the AI phone host section (it
  // survives as a pricing tier), the FAQ, and the mid-page CTA slab. Fewer
  // sections is the point: one list of what we run, one list of what it does.
  sections: [
    {
      type: 'nav',
      // Labels slugify to section ids: 'What we do' -> #what-we-do.
      links: ['What we do', 'Product', 'Pricing'],
      cta: { label: VERB, href: CAPTURE },
      // Overlay now that the opening is a saturated colour field: white-on-
      // paprika at the top, and the bar fades to paper once you are past it.
      // (It was deliberately NOT overlay while the opening sat on cream, where
      // white-on-photo styling would have been invisible.)
      overlay: true,
    },
    opening,
    whatWeDo,
    product,
    howItWorks,
    pricing,
    bookCall,
    inquiry,
    {
      type: 'footer',
      legal: `${NAME}™ — direct online ordering for independent restaurants. No commission on any tier. Pricing shown is current as of October 2026.`,
    },
  ],
}

export default config
