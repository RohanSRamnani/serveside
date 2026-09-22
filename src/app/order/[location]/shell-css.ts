/**
 * The storefront's paper and ink — the design tokens and the base type, shared by
 * every customer-facing page under `/order/`.
 *
 * **Extracted so there is exactly one of it.** `browse.tsx` owned this block while it
 * was the only storefront page; checkout is the second, and a customer who taps
 * Checkout must not watch the paper change colour. Two copies that agree today are
 * two that stop agreeing the first time one is tuned — and `--accent` is the
 * restaurant's one red, which is precisely the value somebody will adjust.
 *
 * A plain string module with **no imports and no `'use client'`**, for the same
 * reason `order-limits.ts` has none: it is read by client components, and a shared
 * constant must not drag a module graph behind it.
 *
 * It deliberately stops at the tokens and the page's own box. Everything below —
 * headers, cards, chips, forms — belongs to the page that draws it, so a rule nobody
 * shares does not ship to a page that does not use it.
 *
 * `color-scheme: light` is load-bearing rather than tidy: the app's `globals.css`
 * flips `html` to `color-scheme: dark` under `prefers-color-scheme`, and without this
 * the browser would paint form controls and scrollbars dark on top of warm paper.
 * A customer's menu is the same warm page at 2am as at noon.
 */
export const SHELL_CSS = `
.ss {
  --paper: #fbf7f2;
  --card: #ffffff;
  --ink: #17120f;
  --ink-soft: #6a5f57;
  --line: #e7ded3;
  --accent: #a9271d;
  --accent-ink: #fff8f6;
  --diet-bg: #e9f4ec;
  --diet-ink: #1d6440;
  --allergen-bg: #fbeadb;
  --allergen-ink: #8a4a12;
  color-scheme: light;
  min-height: 100dvh;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-geist-sans), system-ui, -apple-system, sans-serif;
  font-size: 16px;
  line-height: 1.4;
}
`
