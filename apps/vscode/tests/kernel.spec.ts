import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseUrlFrom, kernelArgs, nodeSearchCandidates, resolveCommand, resolveNodeExecutable } from '../src/kernel.ts'

/**
 * Kernel launch contract: the exact CLI arguments that shape the web kernel,
 * the loopback URL line it prints on readiness, and command resolution. These
 * pin what the extension must observe to boot the shared `dsh --profile web`
 * host — the runtime surface that replaced the deleted cordis.yml composition.
 */
describe('web kernel launch contract', () => {
  it('builds the loopback kernel arguments', () => {
    expect(kernelArgs()).toEqual(['--profile', 'web', '--no-open', '--port', '0'])
  })

  it('parses the base URL from the startup line', () => {
    expect(baseUrlFrom('dsh web: http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321')
  })

  it('accepts a trailing slash on the startup line', () => {
    expect(baseUrlFrom('dsh web: http://127.0.0.1:54321/')).toBe('http://127.0.0.1:54321')
  })

  it('finds the URL line in the middle of longer output', () => {
    const output = [
      'some banner',
      'dsh web: http://127.0.0.1:54321',
      'more output',
    ].join('\n')
    expect(baseUrlFrom(output)).toBe('http://127.0.0.1:54321')
  })

  it('returns undefined before the URL line has printed', () => {
    expect(baseUrlFrom('')).toBeUndefined()
    expect(baseUrlFrom('still starting up')).toBeUndefined()
  })

  it('ignores non-loopback host lines', () => {
    expect(baseUrlFrom('dsh web: http://0.0.0.0:54321')).toBeUndefined()
  })

  it('passes absolute commands through unchanged', () => {
    const absolute = resolve('tools', 'dsh')
    expect(resolveCommand(absolute, 'C:/unused')).toBe(absolute)
  })

  it('resolves relative commands against the workspace cwd', () => {
    const cwd = resolve('work')
    expect(resolveCommand('bin/dsh', cwd)).toBe(resolve(cwd, 'bin/dsh'))
  })

  it('derives node.exe candidates in PATH order on Windows', () => {
    const candidates = nodeSearchCandidates('C:\\a;C:\\b', 'win32')
    expect(candidates).toEqual(['C:\\a\\node.exe', 'C:\\b\\node.exe'])
  })

  it('derives bare node candidates on posix', () => {
    const candidates = nodeSearchCandidates('/usr/bin:/bin', 'linux')
    expect(candidates).toEqual(['/usr/bin/node', '/bin/node'])
  })

  it('skips empty PATH entries', () => {
    expect(nodeSearchCandidates(';C:\\a;;', 'win32')).toEqual(['C:\\a\\node.exe'])
  })

  it('honors the DSH_NODE_EXE override over PATH search', () => {
    const nodeExe = resolve('tools', 'node.exe')
    expect(resolveNodeExecutable('C:\\unused', nodeExe)).toBe(nodeExe)
  })

  it('falls back to PATH candidates before the host execPath', () => {
    const found = resolveNodeExecutable('C:\\has-node')
    expect(found).toContain('node')
  })
})
