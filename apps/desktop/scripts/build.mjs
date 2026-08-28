#!/usr/bin/env node
// Bundle the Electron desktop app's four runtime entries with esbuild.
// Electron's main, preload, and utilityProcess entries ship as ESM (Electron
// 28+ loads ESM via the package "type": "module"); the renderer transport
// ships as a browser IIFE so the SPA reads window.__DSH_TRANSPORT__ from a
// plain <script> ahead of its module graph. `electron` stays external in
// every Node-targeted bundle.
import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const watch = process.argv.includes('--watch')

const nodeBundle = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
}

const main = {
  ...nodeBundle,
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(root, 'dist/main.js'),
}

const preload = {
  ...nodeBundle,
  entryPoints: [resolve(root, 'src/preload/index.ts')],
  outfile: resolve(root, 'dist/preload.mjs'),
}

// The kernel host class imports only Node builtins; electron stays external so
// the utility process never pulls in the Electron runtime.
const kernelEntry = {
  ...nodeBundle,
  entryPoints: [resolve(root, 'src/kernel/entry.ts')],
  outfile: resolve(root, 'dist/kernel-entry.js'),
}

const rendererTransport = {
  ...nodeBundle,
  entryPoints: [resolve(root, 'src/carrier/renderer-transport.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  external: [],
  outfile: resolve(root, 'dist/renderer-transport.js'),
}

const entries = [main, preload, kernelEntry, rendererTransport]

if (watch) {
  const contexts = await Promise.all(entries.map(context))
  await Promise.all(contexts.map(ctx => ctx.watch()))
} else {
  await Promise.all(entries.map(build))
}
