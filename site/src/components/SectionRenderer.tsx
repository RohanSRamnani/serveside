import type { ComponentType } from 'react'
import type { SectionConfig, SectionType, BrandConfig, BusinessConfig, SectionOverrides, SectionProps, SiteMeta } from '@/lib/types'
import Nav from '@/components/Nav'
import Footer from '@/components/Footer'

// Trimmed from the client-site factory: serveside.co renders nav and footer
// from the shared sections and every other type through config.overrides.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous section registry: each section type has its own config shape
const defaultSections: Partial<Record<SectionType, ComponentType<SectionProps<any>>>> = { nav: Nav, footer: Footer }

interface SectionRendererProps {
  sections: SectionConfig[]
  brand: BrandConfig
  business: BusinessConfig
  site: SiteMeta
  overrides?: SectionOverrides
}

export default function SectionRenderer({ sections, brand, business, site, overrides }: SectionRendererProps) {
  return (
    <>
      {sections.map((section, i) => {
        const Component = overrides?.[section.type] ?? defaultSections[section.type]
        if (!Component) throw new Error(`No component for section type "${section.type}"`)
        return <Component key={`${section.type}-${i}`} config={section} brand={brand} business={business} site={site} />
      })}
    </>
  )
}
