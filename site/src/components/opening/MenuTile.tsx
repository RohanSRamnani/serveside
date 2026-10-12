import type { CSSProperties } from 'react'
import s from './opening.module.css'

/**
 * The menu goes live: tonight's special, set on an ink tile.
 *
 * AN EXAMPLE DISH, off the fictional Marigold menu (`src/clients/marigold`),
 * never a real client's — see IMAGERY at the top of config.ts. Its braised
 * short rib at $32, written the way a chalkboard special is — "Soft polenta,
 * gremolata, pan juices." — tagged `Dairy`. "Braised Short Rib" in full is
 * 8px too wide for the phone card and clips mid-word, hence the short name.
 * It is also the dish this page's own "86 button" row runs out of at seven, so
 * the special that goes live here is the one that sells out further down. One
 * allergen pill, because the dish has one allergen tag; nothing here invents a
 * second.
 *
 * Under motion the name types in, the price sets itself digit by digit, the
 * description lands, the pill pops, and the live dot comes on — "email us a
 * photo of tonight's special and it is live the same day". The still
 * composition shows it live.
 */

const NAME = 'Short Rib' // 9 characters; the typing keyframe steps 9 times.

function Digit({ value }: { value: number }) {
  return (
    <span className={s.mnDigit}>
      <span className={s.mnCol} style={{ ['--d' as string]: value } as CSSProperties}>
        {Array.from({ length: 10 }, (_, n) => (
          <span key={n}>{n}</span>
        ))}
      </span>
    </span>
  )
}

export default function MenuTile() {
  return (
    <div className={s.mnCard}>
      <p className={s.mnEyebrow}>Tonight’s special</p>

      <div className={s.mnIn}>
        <span className={s.mnLiveWrap}>
          <span className={s.mnLiveDotWrap}>
            <span className={s.mnLiveDot} />
            <span className={s.mnLiveRing} />
          </span>
          <span className={s.mnLiveLabel}>Live</span>
        </span>

        <div className={s.mnNameBox}>
          <span className={s.mnGhost} aria-hidden>
            {NAME}
          </span>
          <span className={s.mnName}>{NAME}</span>
        </div>

        <div className={s.mnPrice}>
          <span>$</span>
          <Digit value={3} />
          <Digit value={2} />
        </div>

        <p className={s.mnDesc}>Soft polenta, gremolata, pan juices.</p>

        <div className={s.mnTags}>
          <span className={s.mnPill}>Dairy</span>
        </div>
      </div>
    </div>
  )
}
