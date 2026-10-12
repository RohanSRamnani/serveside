import { Inter, Space_Grotesk } from 'next/font/google'

// preload: false — matches the client-site factory, where these load only on
// pages whose preset asks for them; the root layout's Inter (preloaded) covers
// the default path.
const inter = Inter({ subsets: ['latin'], preload: false })
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], preload: false })

export const fonts: Record<string, { style: { fontFamily: string } }> = {
  inter,
  'space-grotesk': spaceGrotesk,
}
