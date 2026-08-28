import { describe, expect, it } from 'vitest'
import { baseUrlFrom, kernelArgs, resolveSystemNode } from '../src/kernel/host.ts'

/**
 * Kernel host pure helpers: the argv contract and the stdout URL parser. The
 * full supervisor (spawn, tree kill, port posting) needs Electron/Node child
 * processes and is covered by the VSCode extension's kernel tests it mirrors;
 * these pin the parts that must not drift.
 */
describe('desktop kernel host', () => {
  it('uses the web profile, no browser handoff, and port 0', () => {
    expect(kernelArgs()).toEqual(['--profile', 'web', '--no-open', '--port', '0'])
  })

  it('extracts the loopback base URL from the ready line', () => {
    const stdout = [
      'booting...',
      'dsh web: http://127.0.0.1:54321 (LAN: http://192.168.1.5:54321)',
      'more logs',
    ].join('\n')
    expect(baseUrlFrom(stdout)).toBe('http://127.0.0.1:54321')
  })

  it('returns undefined before the ready line prints', () => {
    expect(baseUrlFrom('still booting\n')).toBeUndefined()
  })

  it('tolerates an optional trailing slash on the ready URL', () => {
    expect(baseUrlFrom('dsh web: http://127.0.0.1:54321/\n')).toBe('http://127.0.0.1:54321')
  })

  it('does not match LAN URLs or non-loopback hosts', () => {
    expect(baseUrlFrom('dsh web: http://localhost:54321\n')).toBeUndefined()
    expect(baseUrlFrom('dsh web: http://0.0.0.0:54321\n')).toBeUndefined()
  })
})

describe('resolveSystemNode', () => {
  it('prefers an existing explicit candidate over the PATH probe', () => {
    const probe = (): string | undefined => { throw new Error('probe must not run') }
    expect(resolveSystemNode([process.execPath], probe)).toBe(process.execPath)
  })

  it('skips missing candidates and falls through to the probe', () => {
    const probe = (): string | undefined => 'C:/probed/node.exe'
    expect(resolveSystemNode(['C:/missing/node.exe'], probe)).toBe('C:/probed/node.exe')
  })

  it('skips empty candidates', () => {
    const probe = (): string | undefined => undefined
    expect(resolveSystemNode(['', undefined], probe)).toBeUndefined()
  })
})
