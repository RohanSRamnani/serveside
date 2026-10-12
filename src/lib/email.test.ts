import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/** The SDK is mocked whole: nothing in this file can reach Resend. */
const { send } = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('resend', () => ({
  Resend: class {
    emails = { send }
  },
}))

import { sendEmail } from './email'

const MESSAGE = {
  to: 'owner@example.com',
  subject: 'Your login code',
  html: '<p>Your code is <b>482913</b></p>',
  text: 'Your code is 482913.\nIt expires in 10 minutes.',
  fromName: 'Serveside',
}

beforeEach(() => {
  send.mockReset()
  send.mockResolvedValue({ data: { id: 'email_1' }, error: null })
  vi.stubEnv('RESEND_API_KEY', 're_test_key')
  vi.stubEnv('EMAIL_FROM_ADDRESS', 'orders@mail.serveside.co')
  vi.stubEnv('VERCEL_ENV', 'development')
  vi.stubEnv('OUTBOUND_FORCE_LIVE_EMAIL', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('sendEmail', () => {
  it('off production, sends nothing and logs the subject and the whole text body', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await sendEmail(MESSAGE)

    expect(send).not.toHaveBeenCalled()
    const line = String(log.mock.calls[0][0])
    expect(line).toContain('[email:dry-run]')
    expect(line).toContain(MESSAGE.subject)
    // The whole body, not a preview: a login code is read from this line in dev.
    expect(line).toContain(MESSAGE.text)
    log.mockRestore()
  })

  it('live, sends from our address under the sender name it was given', async () => {
    vi.stubEnv('OUTBOUND_FORCE_LIVE_EMAIL', '1')

    await sendEmail({ ...MESSAGE, fromName: "Bari's Pizza orders" })

    expect(send).toHaveBeenCalledWith({
      from: "Bari's Pizza orders <orders@mail.serveside.co>",
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
    })
  })

  it('throws when Resend refuses, so the Inngest step retries', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    send.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'Invalid `to` field', statusCode: 422 },
    })

    await expect(sendEmail(MESSAGE)).rejects.toThrow(/validation_error/)
  })
})
