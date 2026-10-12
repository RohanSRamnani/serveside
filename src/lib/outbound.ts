/**
 * Whether a message on this channel may actually leave the process.
 *
 * Only production sends. Everywhere else — `next dev`, a preview deploy, the suite —
 * every SMS and email is logged instead, because the database those run against holds
 * real restaurants' real phone numbers and addresses, and a seeded order in dev must
 * never text an owner at 2am.
 *
 * Each channel has its own force flag so that a developer testing email never texts
 * anyone as a side effect: `OUTBOUND_FORCE_LIVE_SMS=1`, `OUTBOUND_FORCE_LIVE_EMAIL=1`.
 */
export function outboundLive(channel: 'sms' | 'email'): boolean {
  if (process.env.VERCEL_ENV === 'production') return true
  return process.env[`OUTBOUND_FORCE_LIVE_${channel.toUpperCase()}`] === '1'
}
