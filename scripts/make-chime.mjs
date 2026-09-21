#!/usr/bin/env node
// Writes `public/chime.wav`, the sound the kitchen feed loops while an order is
// waiting to be acknowledged. Committed so the binary in `public/` is not a mystery:
// run `node scripts/make-chime.mjs` to reproduce it byte for byte.
//
// Shaped for a noisy kitchen, not for a phone: two rising tones that cut through
// extraction fans, then most of a second of silence so a loop nags rather than
// drones. 8 kHz mono is plenty — the top partial is under 1.2 kHz — and keeps the
// file at 24 KB, which matters on a tablet re-fetching it over restaurant wifi.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const RATE = 8000
const SECONDS = 1.5
const TONES = [
  { hz: 880, start: 0.0, length: 0.18 },   // A5
  { hz: 1174.66, start: 0.2, length: 0.26 }, // D6
]

const samples = new Int16Array(Math.round(RATE * SECONDS))
for (const { hz, start, length } of TONES) {
  const from = Math.round(start * RATE)
  const count = Math.round(length * RATE)
  for (let i = 0; i < count; i++) {
    // Raised-cosine envelope: a square-edged tone clicks on a cheap tablet speaker.
    const envelope = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / count)
    samples[from + i] = Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * envelope * 0.7 * 32767)
  }
}

const data = Buffer.from(samples.buffer)
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)          // PCM chunk size
header.writeUInt16LE(1, 20)           // format: PCM
header.writeUInt16LE(1, 22)           // channels: mono
header.writeUInt32LE(RATE, 24)
header.writeUInt32LE(RATE * 2, 28)    // byte rate
header.writeUInt16LE(2, 32)           // block align
header.writeUInt16LE(16, 34)          // bits per sample
header.write('data', 36)
header.writeUInt32LE(data.length, 40)

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'chime.wav')
writeFileSync(out, Buffer.concat([header, data]))
console.log(`wrote ${out} (${header.length + data.length} bytes)`)
