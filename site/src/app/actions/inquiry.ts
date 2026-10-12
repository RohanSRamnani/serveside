'use server'

import { headers } from 'next/headers'
import { Resend } from 'resend'

// The inquiry form's server half. Mirrors serveside-sites' lead action
// (src/app/actions/lead.ts + src/lib/leads.ts): Resend, LEAD_FROM_EMAIL, and
// demo mode when the keys are unset, so a local run validates and reports
// success without sending anything. The recipient is LEAD_TO_EMAIL, never a
// hard-coded address and never anything from the submitted form.

export type InquiryFormState = { status: 'idle' | 'sent' | 'error'; error?: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_FIELD = 200
const MAX_MESSAGE = 4000
const LIMIT = 5
const HOUR_MS = 60 * 60 * 1000

// ponytail: per-instance in-memory limit, move to a store if spam appears
const hits = new Map<string, number[]>()

function allow(ip: string, now: number): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < HOUR_MS)
  if (recent.length >= LIMIT) {
    hits.set(ip, recent)
    return false
  }
  recent.push(now)
  hits.set(ip, recent)
  return true
}

async function clientIp(): Promise<string> {
  const h = await headers()
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown'
}

export async function submitInquiry(_prev: InquiryFormState, formData: FormData): Promise<InquiryFormState> {
  if (!allow(await clientIp(), Date.now())) {
    return { status: 'error', error: 'Too many messages from here. Please try again in an hour, or book a call above.' }
  }

  const get = (k: string) => String(formData.get(k) ?? '').trim()

  // Honeypot: a hidden field people never see. A bot fills it; pretend it worked.
  if (get('website')) return { status: 'sent' }

  const name = get('name')
  const restaurant = get('restaurant')
  const neighborhood = get('neighborhood')
  const email = get('email')
  const phone = get('phone')
  const message = get('message')

  if (!name) return { status: 'error', error: 'Please add your name.' }
  if (!restaurant) return { status: 'error', error: 'Please add the restaurant’s name.' }
  if (!neighborhood) return { status: 'error', error: 'Please add the neighborhood.' }
  if (!EMAIL_RE.test(email)) return { status: 'error', error: 'Please use a valid email address.' }
  if ([name, restaurant, neighborhood, email, phone].some((v) => v.length > MAX_FIELD) || message.length > MAX_MESSAGE) {
    return { status: 'error', error: 'That is longer than we can take. Please shorten it.' }
  }

  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.LEAD_FROM_EMAIL
  const to = process.env.LEAD_TO_EMAIL
  if (!apiKey || !from || !to) {
    console.warn(`[inquiry] demo mode — RESEND_API_KEY/LEAD_FROM_EMAIL/LEAD_TO_EMAIL not set. Inquiry from ${email} not delivered.`)
    return { status: 'sent' }
  }

  const text = [
    `Name: ${name}`,
    `Restaurant: ${restaurant}`,
    `Neighborhood: ${neighborhood}`,
    `Email: ${email}`,
    phone ? `Phone: ${phone}` : null,
    message ? `\n${message}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n')

  const { error } = await new Resend(apiKey).emails.send({
    from,
    to: [to],
    replyTo: email,
    subject: `New inquiry: ${restaurant} (${neighborhood})`,
    text,
  })
  if (error) {
    console.error('[inquiry] send failed', error)
    return { status: 'error', error: 'Something went wrong sending your message. Please book a call above instead.' }
  }
  return { status: 'sent' }
}
