#!/usr/bin/env node
// Bundle the VSCode extension host entry with esbuild.
// The vscode module stays external; everything else — including the dsh
// workspace packages — bundles into the self-contained extension.cjs an
// installed VSIX can load without node_modules. esbuild's CJS entry output
// defines `activate`/`deactivate` on module.exports as enumerable getters
// (`__export`), which is what the extension host requires; do not reassign
// them in a footer — the properties have no setter and the assignment throws
// under "use strict", failing activation.
import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const watch = process.argv.includes('--watch')

const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  external: ['vscode', '@vscode/*'],
  logLevel: 'info',
}

const extension = {
  ...shared,
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile: resolve(root, 'dist/extension.cjs'),
}

// The webview transport ships as a browser IIFE: the SPA's connection plugin
// reads window.__DSH_TRANSPORT__ from it before boot, so it must be a plain
// script the panel index loads ahead of the app. Nothing stays external — the
// apiproxy client half is browser-safe and bundles in.
const transport = {
  ...shared,
  entryPoints: [resolve(root, 'src/webview-transport.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: resolve(root, 'dist/webview-transport.js'),
}

if (watch) {
  const contexts = await Promise.all([context(extension), context(transport)])
  await Promise.all(contexts.map(ctx => ctx.watch()))
} else {
  await Promise.all([build(extension), build(transport)])
}
