import { existsSync } from 'node:fs'
import Module from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = resolve(here, '../dist/extension.cjs')

/**
 * The extension host requires this CJS bundle directly; a bundle that throws
 * at load time fails activation and the sidebar view never renders. Loading
 * through the same loader here pins the contract: no assignment to esbuild's
 * getter-only named exports, and `activate`/`deactivate` present on
 * module.exports.
 */
describe.skipIf(!existsSync(bundle))('extension bundle activation surface', () => {
  it('loads as CJS with vscode externalized and exposes both activation hooks', () => {
    type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown
    const target = Module as unknown as { _load: LoadFn }
    const original = target._load
    target._load = function patched(request, parent, isMain) {
      if (request === 'vscode') return {}
      return original.call(this, request, parent, isMain)
    }
    try {
      const req = createRequire(import.meta.url)
      const extension = req(bundle) as { activate?: unknown; deactivate?: unknown }
      expect(typeof extension.activate).toBe('function')
      expect(typeof extension.deactivate).toBe('function')
    } finally {
      target._load = original
    }
  })
})
