import { cn } from '@/lib/utils'
import s from './opening.module.css'

/**
 * The order arrives: one card off the kitchen feed.
 *
 * Same information architecture as the real board (`serveside/src/app/feed`):
 * the short code set large, the status, minutes waiting, fulfilment and how
 * the money stands, the lines with their modifiers and the customer's note, the
 * total, then Accept with the prep bumps beside it. The same example order as
 * the ticket next to it — 8HTP, $76.80, off the fictional Marigold menu — so
 * the two tiles are one order seen from two places.
 *
 * Re-set in this page's own palette rather than the board's fixed dark: this
 * is an illustration of the operation, not a capture of the product. The
 * accent is spent on exactly one fact, that the order is NEW — the border, the
 * dot, the label and the hollow Accept pill — and under motion the pill takes
 * the tap and fills, the label flips, the border goes quiet.
 */
export default function FeedTile() {
  return (
    <div className={s.fdCard}>
      <div className={s.fdIn}>
        <p className={s.fdEyebrow}>Kitchen feed</p>

        <div className={s.fdTop}>
          <span className={s.fdCode}>8HTP</span>
          <span className={s.fdStatus}>
            <span className={s.fdDotWrap}>
              <span className={s.fdDot} />
              <span className={s.fdRing} />
              <span className={cn(s.fdRing, s.fdRing2)} />
            </span>
            <span className={s.fdStatusText}>
              <span className={s.fdNew}>New</span>
              <span className={s.fdAcc}>Accepted</span>
            </span>
          </span>
          <span className={s.fdWait}>0 min</span>
        </div>

        <p className={s.fdWho}>Pickup · pay at pickup</p>

        <ul className={s.fdLines}>
          <li className={s.fdLine}>
            <span className={s.fdQty}>2×</span>
            <span>
              <span className={s.fdDish}>Wood-Grilled Chicken</span>
              <span className={s.fdMods}>Dark meat · “no lemon”</span>
            </span>
          </li>
          <li className={s.fdLine}>
            <span className={s.fdQty}>1×</span>
            <span>
              <span className={s.fdDish}>Duck Fat Potatoes</span>
            </span>
          </li>
        </ul>

        <p className={s.fdMoney}>$76.80</p>

        <div className={s.fdBtns}>
          <span className={s.fdBtn}>Accept</span>
          <span className={s.fdBump}>+5 min</span>
          <span className={cn(s.fdBump, s.fdBumpWide)}>+10 min</span>
        </div>
      </div>
    </div>
  )
}
