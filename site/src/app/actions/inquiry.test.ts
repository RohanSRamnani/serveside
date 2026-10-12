import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { send, ip } = vi.hoisted(() => ({ send: vi.fn(), ip: { value: '203.0.113.1' } }))

vi.mock('resend', () => ({
  Resend: class {
    emails = { send }
  },
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': `${ip.value}, 10.0.0.1` }),
}))

const { submitInquiry } = await import('./inquiry')

const valid = {
  name: 'Ana Ruiz',
  restaurant: 'Marigold',
  neighborhood: 'Park Slope',
  email: 'ana@marigold.example',
  phone: '',
  message: '',
}
const idle = { status: 'idle' as const }
let n = 0

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.set(k, v)
  return f
}

beforeEach(() => {
  ip.value = `203.0.113.${++n}` // one IP per test: the limiter is module state
  send.mockReset().mockResolvedValue({ data: { id: 'x' }, error: null })
  vi.stubEnv('RESEND_API_KEY', 're_test')
  vi.stubEnv('LEAD_FROM_EMAIL', 'from@serveside.example')
  vi.stubEnv('LEAD_TO_EMAIL', 'to@serveside.example')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('submitInquiry', () => {
  it('sends a valid inquiry to LEAD_TO_EMAIL, reply-to the owner', async () => {
    expect(await submitInquiry(idle, fd(valid))).toEqual({ status: 'sent' })
    expect(send).toHaveBeenCalledOnce()
    const mail = send.mock.calls[0][0]
    expect(mail.to).toEqual(['to@serveside.example'])
    expect(mail.from).toBe('from@serveside.example')
    expect(mail.replyTo).toBe('ana@marigold.example')
    expect(mail.text).toContain('Marigold')
    expect(mail.text).not.toContain('Phone:')
  })

  it.each([
    ['name', ''],
    ['restaurant', ''],
    ['neighborhood', ''],
    ['email', 'not-an-email'],
    ['name', 'x'.repeat(201)],
  ])('refuses %s = %j', async (field, value) => {
    const r = await submitInquiry(idle, fd({ ...valid, [field]: value }))
    expect(r.status).toBe('error')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends nothing in demo mode', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    expect(await submitInquiry(idle, fd(valid))).toEqual({ status: 'sent' })
    expect(send).not.toHaveBeenCalled()
  })

  it('drops a filled honeypot silently', async () => {
    expect(await submitInquiry(idle, fd({ ...valid, website: 'http://spam.example' }))).toEqual({ status: 'sent' })
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses the 6th request in an hour from one IP', async () => {
    for (let i = 0; i < 5; i++) expect((await submitInquiry(idle, fd(valid))).status).toBe('sent')
    const sixth = await submitInquiry(idle, fd(valid))
    expect(sixth.status).toBe('error')
    expect(send).toHaveBeenCalledTimes(5)
  })

  it('reports a Resend failure as an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    send.mockResolvedValue({ data: null, error: { message: 'nope' } })
    expect((await submitInquiry(idle, fd(valid))).status).toBe('error')
  })
})
