import { describe, it, expect } from 'vitest'
import { makeShortCode, SHORT_CODE_ALPHABET } from './short-code'

/** Written out, not imported: the alphabet is the contract, so the test must own a copy. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const draw = (n: number) => Array.from({ length: n }, () => makeShortCode())

describe('makeShortCode', () => {
  it('is the exact alphabet the spec names', () => {
    expect(SHORT_CODE_ALPHABET).toBe(ALPHABET)
    expect(ALPHABET).toHaveLength(30)
  })

  it('is four characters', () => {
    expect(draw(200).filter((c) => c.length !== 4)).toEqual([])
  })

  it('uses only alphabet characters', () => {
    const strays = draw(500).join('').split('').filter((ch) => !ALPHABET.includes(ch))
    expect(strays).toEqual([])
  })

  it('never emits a character a human reads back wrong over the phone', () => {
    // The whole point of the alphabet: 0/O, 1/I/L and U (heard as "you") are out.
    const banned = /[01OILU]/
    expect(draw(500).filter((c) => banned.test(c))).toEqual([])
  })

  it('reaches every character of the alphabet', () => {
    // 4,000 characters over 30 slots — a slice the generator can never produce (a
    // truncated alphabet, a modulo that can't reach the tail) shows up here.
    const seen = new Set(draw(1_000).join(''))
    expect([...ALPHABET].filter((ch) => !seen.has(ch))).toEqual([])
  })

  it('is random, not a counter', () => {
    // 30^4 = 810,000 codes. 200 draws collide ~2.4% of the time, so assert spread,
    // not uniqueness — a uniqueness assertion here would be a flaky test by design.
    expect(new Set(draw(200)).size).toBeGreaterThan(180)
  })

  it('does not favour the front of the alphabet', () => {
    // The modulo-bias trap: 256 = 8×30 + 16, so a plain `byte % 30` hands the first
    // 16 characters 9 bytes each and the last 14 only 8 — they come up 12.5% more
    // often, and the code space shrinks accordingly.
    //
    // Sized so the two hypotheses are far apart, and checked against a biased
    // generator rather than assumed: over 40,000 characters a fair one puts
    // 21,333 ± 100 (1σ) in the first 16, a biased one 22,500 — a gap of 11σ. The
    // ±500 window is 5σ from fair and 6.7σ from biased, so it names which generator
    // is running and does not flake. (At 12,000 characters the two distributions
    // overlap and the test is a coin toss; this is the reason for the sample size.)
    const chars = draw(10_000).join('')
    const front = [...chars].filter((ch) => ALPHABET.indexOf(ch) < 16).length
    expect(Math.abs(front - (chars.length * 16) / 30)).toBeLessThan(500)
  })
})
