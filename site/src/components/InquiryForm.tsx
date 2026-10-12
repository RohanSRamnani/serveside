'use client'

import { useActionState } from 'react'
import { submitInquiry, type InquiryFormState } from '@/app/actions/inquiry'
import { useReveal } from '@/hooks/use-reveal'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { InquirySection, SectionProps } from '@/lib/types'

const initialState: InquiryFormState = { status: 'idle' }

const fieldClass =
  'w-full rounded-lg border border-border bg-background px-4 py-3 text-base text-foreground placeholder:text-foreground/40 focus:outline-none focus:ring-2 focus:ring-accent'
const labelClass = 'mb-1.5 block text-sm font-medium text-foreground/80'

function Field({ id, label, ...input }: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={`inquiry-${id}`} className={labelClass}>
        {label}
      </label>
      <input id={`inquiry-${id}`} name={id} className={fieldClass} {...input} />
    </div>
  )
}

/**
 * Overrides `inquiry`. The second way in, directly under the calendar and on
 * the same ground, for an owner who would rather write than book. Mirrors
 * serveside-sites' LeadForm; the server half is app/actions/inquiry.ts.
 */
export default function InquiryForm({ config }: SectionProps<InquirySection>) {
  const ref = useReveal()
  const [state, formAction, pending] = useActionState(submitInquiry, initialState)

  return (
    <section id="inquiry" className="bg-muted px-6 pb-24 sm:pb-32">
      <div
        ref={ref}
        className="reveal-item mx-auto max-w-3xl rounded-[var(--radius-xl)] border border-border bg-background p-7 sm:p-10"
      >
        <h2 className="text-2xl font-bold tracking-[-0.02em] text-foreground sm:text-3xl">{config.headline}</h2>
        {config.subtitle && <p className="mt-3 text-base leading-relaxed text-foreground/65">{config.subtitle}</p>}

        {state.status === 'sent' ? (
          <p className="mt-8 text-lg font-semibold text-foreground" role="status">
            Got it. We will reply by email.
          </p>
        ) : (
          <form action={formAction} className="mt-8 space-y-5">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field id="name" label="Your name" required autoComplete="name" />
              <Field id="restaurant" label="Restaurant" required autoComplete="organization" />
              <Field id="neighborhood" label="Neighborhood" required placeholder="Park Slope" />
              <Field id="email" label="Email" type="email" required autoComplete="email" />
              <Field id="phone" label="Phone (optional)" type="tel" autoComplete="tel" />
            </div>
            <div>
              <label htmlFor="inquiry-message" className={labelClass}>
                Anything else (optional)
              </label>
              <textarea id="inquiry-message" name="message" rows={4} className={fieldClass} />
            </div>

            {/* Honeypot. Off-screen rather than display:none, which some bots skip. */}
            <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor="inquiry-website">Website</label>
              <input id="inquiry-website" name="website" tabIndex={-1} autoComplete="off" />
            </div>

            {state.status === 'error' && (
              <p className="text-sm text-accent" role="alert">
                {state.error}
              </p>
            )}

            <button
              type="submit"
              disabled={pending}
              className={cn(
                buttonVariants({ size: 'lg' }),
                'press h-13 w-full rounded-full bg-accent px-8 text-base font-semibold text-accent-foreground shadow-sm hover:bg-accent/90 disabled:opacity-60 sm:w-auto',
              )}
            >
              {pending ? 'Sending…' : 'Send'}
            </button>
          </form>
        )}
      </div>
    </section>
  )
}
