import { config } from 'dotenv'
import { afterAll } from 'vitest'
import { closeScopedPool } from '@/repo/scoped'

config({ path: '.env.test', quiet: true })

// The websocket pool keeps sockets open, and a worker with a live socket does not
// exit. Lazy, so a file that never calls withLocation never opens one.
afterAll(async () => {
  await closeScopedPool()
})
