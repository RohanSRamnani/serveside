import { describe, it, expect } from 'vitest'
import { env } from './env'

describe('env', () => {
  it('returns a set variable', () => {
    process.env.SPINE_TEST_VAR = 'x'
    expect(env('SPINE_TEST_VAR')).toBe('x')
  })
  it('throws with the variable name on missing', () => {
    delete process.env.SPINE_MISSING
    expect(() => env('SPINE_MISSING')).toThrow(/SPINE_MISSING/)
  })
})
