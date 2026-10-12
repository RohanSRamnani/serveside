import { Resend } from 'resend'
import { env } from '@/lib/env'
import { outboundLive } from '@/lib/outbound'

/**
 * One email, over Resend. Same contract as `sendSms`: it either hands the message to
 * Resend or it **throws**, so the Inngest step that calls it retries.
 *
 * `fromName` is who the reader thinks wrote it — the restaurant's name on an owner's
 * order email, "Serveside" on a login code. The address is always ours
 * (`EMAIL_FROM_ADDRESS`, on the one verified sending subdomain).
 *
 * Env: `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`. Read on first send rather than at
 * import, so a deploy with either unset fails the email step and only that step.
 */
let _resend: Resend | null = null

function resend(): Resend {
  return (_resend ??= new Resend(env('RESEND_API_KEY')))
}

export type Email = { to: string; subject: string; html: string; text: string; fromName: string }

export async function sendEmail({ to, subject, html, text, fromName }: Email): Promise<void> {
  // The full text body, on purpose: this is how a developer reads a login code locally.
  // It never runs in production, where `outboundLive` is always true.
  if (!outboundLive('email')) {
    console.log(`[email:dry-run] subject=${subject}\n${text}`)
    return
  }

  // Resend reports a refusal in the result rather than throwing, so a missing check
  // here is an email that silently never left.
  const { error } = await resend().emails.send({
    from: `${fromName} <${env('EMAIL_FROM_ADDRESS')}>`,
    to,
    subject,
    html,
    text,
  })
  if (error) throw new Error(`Resend refused the email to ${to}: ${error.name} ${error.message}`)
}
