#!/usr/bin/env node
// Bundle the VSCode extension host entry with esbuild.
// The vscode module and dsh runtime packages stay external; only the
// extension's own TypeScript is bundled into dist/extension.js.
import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const watch = process.argv.includes('--watch')

const shared = {
  entryPoints: [resolve(root, 'src/extension.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  external: ['vscode', '@vscode/*'],
  outfile: resolve(root, 'dist/extension.cjs'),
  logLevel: 'info',
  // esbuild's CJS output guards the named-export assignment behind a falsy
  // interop check (`0 && (module.exports = ...)`), which VSCode's extension
  // host never executes. The footer re-exports the activation hooks on the
  // real module.exports so require('.../extension.cjs').activate is defined.
  footer: {
    js: 'module.exports.activate = activate; module.exports.deactivate = deactivate;',
  },
}

if (watch) {
  const ctx = await context(shared)
  await ctx.watch()
} else {
  await build(shared)
}
