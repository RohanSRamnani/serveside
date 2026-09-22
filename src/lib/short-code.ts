/**
 * The order code a diner reads off their phone and a cook reads off a ticket.
 *
 * Four characters from a 30-character alphabet with every look-alike removed:
 * no `0`/`O`, no `1`/`I`/`L`, and no `U` (it comes back as "you" over a phone).
 * 30^4 = 810,000 codes — plenty to tell apart the orders on one counter at one
 * time, which is all a short code is for. It is **not** an identifier: the order
 * id is the uuid, and nothing may look an order up by short code alone.
 */
export const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

const CODE_LENGTH = 4
/** 240 = 8 × 30. See `randomIndex`. */
const UNBIASED_CEILING = Math.floor(256 / SHORT_CODE_ALPHABET.length) * SHORT_CODE_ALPHABET.length

export function makeShortCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += SHORT_CODE_ALPHABET[randomIndex()]
  return code
}

/**
 * Uniform over 0–29, by rejection rather than `% 30`: 256 is not a multiple of 30,
 * so the naive modulo deals the first 16 characters 9 bytes each and the last 14
 * only 8 — a 12.5% lean that costs real code space for nothing.
 *
 * Web Crypto, not `node:crypto` — this runs behind order creation, which must keep
 * working if a route ever moves to the edge runtime. (Predictability is not the
 * concern; a short code guards nothing. Cheap and correct beats `Math.random`.)
 */
function randomIndex(): number {
  const byte = new Uint8Array(1)
  do {
    crypto.getRandomValues(byte)
  } while (byte[0] >= UNBIASED_CEILING)
  return byte[0] % SHORT_CODE_ALPHABET.length
}
