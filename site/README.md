# serveside.co

The Serveside marketing site. A standalone Next app, separate from the ordering
engine in the repo root: it never imports from `../src`, and it deploys as its
own Vercel project.

All copy and prices live in `src/config.ts`. Read its header first — the voice
and honesty rules there apply to every word on the page.

## Run

```bash
npm --prefix site install
npm --prefix site run dev        # http://localhost:3000
npm --prefix site run build
npm --prefix site run start      # serve the build
npm --prefix site test           # vitest
npm --prefix site run typecheck
```

## Deploy

Vercel project with **Root Directory `site`**. Pushes deploy it; nothing in the
engine's build touches it. Point `serveside.co` at this project.

## Env

Listed in `.env.example`. Set them in Vercel for the inquiry form to send:

- `RESEND_API_KEY` — Resend API key
- `LEAD_FROM_EMAIL` — sender address on a domain verified in Resend
- `LEAD_TO_EMAIL` — where inquiries go

Any of the three unset = demo mode: the form validates and reports success but
sends nothing. The form also has a honeypot and a 5-per-hour-per-IP limit,
kept in memory per server instance.
