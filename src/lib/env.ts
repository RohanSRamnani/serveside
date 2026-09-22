export function env(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') throw new Error(`Missing required env var: ${name}`)
  return v
}
