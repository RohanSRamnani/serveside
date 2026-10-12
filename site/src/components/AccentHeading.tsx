import { Fragment } from 'react'

/**
 * A heading where ONE word carries the display italic in the accent colour:
 * `"North India, {reimagined}."` The braces never render.
 *
 * There is no animation here on purpose. An earlier version decoded the text
 * through random glyphs on first view; it reads as a tech-brand effect and was
 * rejected for hospitality. Type that is simply set well is the effect.
 */
export default function AccentHeading({
  text,
  as: Tag = 'span',
  className,
}: {
  text: string
  as?: 'h1' | 'h2' | 'h3' | 'p' | 'span'
  className?: string
}) {
  const segments = text.split(/(\{[^}]*\})/).filter(Boolean)

  return (
    <Tag className={className}>
      {segments.map((seg, i) =>
        seg.startsWith('{') ? (
          <span key={i} className="accent-word">
            {seg.slice(1, -1)}
          </span>
        ) : (
          <Fragment key={i}>{seg}</Fragment>
        ),
      )}
    </Tag>
  )
}
