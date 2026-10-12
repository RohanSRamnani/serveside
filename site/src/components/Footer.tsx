import type { SectionProps, FooterSection } from '@/lib/types'

export default function Footer({ config, business, site }: SectionProps<FooterSection>) {
  const year = new Date().getFullYear()

  return (
    <footer className="bg-primary py-14 text-primary-foreground">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-6 text-center">
        <div className="flex items-center gap-2.5">
          <span className="h-5 w-1.5 rounded-full bg-accent" aria-hidden />
          <span className="text-lg font-semibold tracking-tight">{site.name}</span>
        </div>
        {business.address && (
          <p className="text-sm text-primary-foreground/70">{business.address}</p>
        )}
        <div className="mt-4 flex flex-col items-center gap-1 border-t border-primary-foreground/15 pt-6">
          <p className="text-xs text-primary-foreground/60">&copy; {year} {site.name}. All rights reserved.</p>
          {config.legal && <p className="text-xs text-primary-foreground/40">{config.legal}</p>}
        </div>
      </div>
    </footer>
  )
}
