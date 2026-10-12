import { describe, expect, it } from 'vitest'
import config from './config'
import { resolveClientConfig } from './styles/presets'

describe('serveside.co config', () => {
  it('resolves against the counter preset', () => {
    const resolved = resolveClientConfig(config)
    expect(resolved.name).toBe('Serveside')
    expect(resolved.brand.accentColor).toBe('#ae3f06')
    expect(resolved.theme?.headingFont).toBe('space-grotesk')
  })

  it('renders the expected sections, in order, each with a component', () => {
    const types = config.sections.map((s) => s.type)
    expect(types).toEqual(['nav', 'hero', 'about', 'services', 'about', 'pricing', 'contact', 'inquiry', 'footer'])
    for (const t of ['hero', 'about', 'services', 'pricing', 'contact', 'inquiry'] as const) {
      expect(config.overrides?.[t]).toBeTypeOf('function')
    }
  })
})
