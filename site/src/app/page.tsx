import type { Metadata } from 'next'
import rawConfig from '@/config'
import { brandToCssVars } from '@/lib/utils'
import { resolveClientConfig } from '@/styles/presets'
import { fonts } from '@/styles/fonts'
import SectionRenderer from '@/components/SectionRenderer'

const SITE_URL = 'https://serveside.co'
const config = resolveClientConfig(rawConfig)
const title = `${config.name} — ${config.tagline}`
const images = config.ogImage ? [{ url: config.ogImage, width: 1200, height: 630, alt: title }] : undefined

export const metadata: Metadata = {
  title,
  description: config.description,
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: '/' },
  openGraph: {
    title,
    description: config.description,
    siteName: config.name,
    type: 'website',
    url: SITE_URL,
    ...(images ? { images } : {}),
  },
  twitter: {
    card: images ? 'summary_large_image' : 'summary',
    title,
    description: config.description,
    ...(images ? { images } : {}),
  },
}

export default function Home() {
  const cssVars: Record<string, string> = { ...brandToCssVars(config.brand) }
  if (config.theme) {
    cssVars['--radius'] = config.theme.radius
    cssVars['--font-heading'] = fonts[config.theme.headingFont].style.fontFamily
    cssVars['--font-body'] = fonts[config.theme.bodyFont].style.fontFamily
  }

  return (
    // bg + text here, not just the vars: the wrapper paints the page ground.
    <div data-client-site className="bg-background text-foreground" style={cssVars as React.CSSProperties}>
      <SectionRenderer
        sections={config.sections}
        brand={config.brand}
        business={config.business}
        site={{ slug: config.slug, name: config.name }}
        overrides={config.overrides}
      />
    </div>
  )
}
