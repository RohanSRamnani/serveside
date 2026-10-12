import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { BrandConfig } from './types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

function hexToOklchParts(hex: string): { L: number; C: number; H: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const toLinear = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  const lr = toLinear(r); const lg = toLinear(g); const lb = toLinear(b)
  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  const l = Math.cbrt(l_); const m = Math.cbrt(m_); const s = Math.cbrt(s_)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bOk = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const C = Math.sqrt(a * a + bOk * bOk)
  let H = (Math.atan2(bOk, a) * 180) / Math.PI
  if (H < 0) H += 360
  return { L, C, H }
}

function hexToOklch(hex: string): string {
  const { L, C, H } = hexToOklchParts(hex)
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`
}

/** Lightness 0..1 in OKLch — the axis that decides legibility. */
export function lightness(hex: string): number {
  return hexToOklchParts(hex).L
}

/** Of two candidate colors, the one that contrasts more with `bg` (by OKLch lightness). */
export function pickContrast(bg: string, a: string, b: string): string {
  const L = lightness(bg)
  return Math.abs(lightness(a) - L) >= Math.abs(lightness(b) - L) ? a : b
}

/** `pct` percent of `tint` mixed into `base`, in OKLab. */
function mix(base: string, tint: string, pct: number): string {
  return `color-mix(in oklab, ${hexToOklch(base)}, ${hexToOklch(tint)} ${pct}%)`
}

// A brand is four colors; every surface token derives from them so that light
// AND dark presets stay legible: foregrounds pick whichever of text/background
// contrasts with the surface, and borders/muted surfaces are mixes rather than
// raw brand colors (a raw primary as border vanishes on a dark preset).
export function brandToCssVars(brand: BrandConfig): Record<string, string> {
  const { primaryColor: primary, accentColor: accent, backgroundColor: bg, textColor: fg } = brand
  return {
    '--primary': hexToOklch(primary),
    '--primary-foreground': hexToOklch(pickContrast(primary, fg, bg)),
    '--accent': hexToOklch(accent),
    '--accent-foreground': hexToOklch(pickContrast(accent, fg, bg)),
    '--background': hexToOklch(bg),
    '--foreground': hexToOklch(fg),
    '--card': mix(bg, fg, 4),
    '--card-foreground': hexToOklch(fg),
    '--muted': mix(bg, fg, 6),
    '--muted-foreground': mix(fg, bg, 35),
    '--secondary': mix(bg, fg, 8),
    '--secondary-foreground': hexToOklch(fg),
    '--border': mix(bg, fg, 14),
    '--input': mix(bg, fg, 20),
    '--ring': hexToOklch(accent),
  }
}
