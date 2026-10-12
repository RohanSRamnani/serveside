import type { CSSProperties } from 'react'
import s from './opening.module.css'

/**
 * The kitchen ticket, and the tile that becomes the page.
 *
 * AN EXAMPLE ORDER, off the fictional Marigold menu (`src/clients/marigold`),
 * never a real client's — see IMAGERY at the top of config.ts. 2× Wood-Grilled
 * Chicken at 26 with a modifier and a line note, 1× Duck Fat Potatoes at 10:
 * subtotal 62.00, tax at NYC's 8.875% (5.5025, half up to 5.50), a 15% tip of
 * 9.30, total 76.80. Laid out by the same rules as
 * `serveside/src/domain/ticket.ts`: 32 columns of Star mC-Print3 roll, money
 * flush right with no `$`, modifiers and notes hanging at a three-space
 * indent. The feed card beside it is the same order.
 *
 * No contact block and no promised time: this page does not print an invented
 * customer.
 *
 * Under motion each line prints in order; the still composition shows the
 * finished ticket. Type and colour only — this is not a screenshot and does
 * not pretend to be one.
 */

const WIDTH = 32
const INDENT = 3

const rule = (ch: string) => ch.repeat(WIDTH)
const centre = (text: string) => ' '.repeat(Math.max(0, Math.floor((WIDTH - text.length) / 2))) + text
const row = (left: string, right: string) => left.padEnd(WIDTH - right.length) + right
const hang = (text: string) => ' '.repeat(INDENT) + text

const LINES: string[] = [
  rule('='),
  centre('*** 8HTP ***'),
  rule('='),
  row('PICKUP', 'PAY AT PICKUP'),
  rule('-'),
  row('2× Wood-Grilled Chicken', '52.00'),
  hang('Dark meat'),
  hang('>> no lemon'),
  row('1× Duck Fat Potatoes', '10.00'),
  rule('-'),
  row('Subtotal', '62.00'),
  row('Tax', '5.50'),
  row('Tip', '9.30'),
  rule('-'),
  row('TOTAL', '76.80'),
  rule('='),
]

export default function TicketTile() {
  return (
    <div className={s.tkPaper}>
      <div className={s.tkFade}>
        <pre className={s.tkPrint}>
          {LINES.map((line, i) => (
            <span key={i} className={s.tl} style={{ ['--i' as string]: i } as CSSProperties}>
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
        {/* The finished ticket, brought up over the idling print as the converge
            begins, so the tile that becomes the page is always fully printed.
            Motion-only; the stylesheet hides it in the still composition. */}
        <pre className={s.tkStill}>{LINES.join('\n')}</pre>
      </div>
    </div>
  )
}
