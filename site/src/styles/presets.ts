import type { BrandConfig, ClientConfig, ResolvedClientConfig } from '@/lib/types'

export interface StylePreset {
  name: string
  brand: Omit<BrandConfig, 'logo' | 'font'>
  headingFont: string // key into the font registry (src/styles/fonts.ts)
  bodyFont: string
  radius: string
}

// Only the preset serveside.co uses, copied from the client-site factory.
export const stylePresets: Record<string, StylePreset> = {
  // Daytime counter service: cafes, bakeries, fast-casual, taquerias.
  counter: {
    name: 'counter',
    brand: { primaryColor: '#1a1613', accentColor: '#d64520', backgroundColor: '#fdf8f0', textColor: '#1a1613' },
    headingFont: 'space-grotesk',
    bodyFont: 'inter',
    radius: '0.75rem',
  },
}

export function resolveClientConfig(config: ClientConfig): ResolvedClientConfig {
  const preset = config.stylePreset ? stylePresets[config.stylePreset] : undefined
  if (!preset) {
    throw new Error(`Unknown stylePreset "${config.stylePreset}". Valid presets: ${Object.keys(stylePresets).join(', ')}`)
  }
  const brand: BrandConfig = {
    ...preset.brand,
    font: preset.bodyFont,
    logo: '',
    ...config.brand,
  }
  return {
    ...config,
    brand,
    theme: { radius: preset.radius, headingFont: preset.headingFont, bodyFont: preset.bodyFont },
  }
}
