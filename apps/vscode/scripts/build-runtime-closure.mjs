#!/usr/bin/env node
// Materialize the self-contained kernel runtime closure for the VSIX.
//
// The VSIX installs with no workspace node_modules around it. The kernel is
// the real `dsh --profile web` stack plus the built web frontend; both must be
// resolvable from the extension directory on a clean machine. This script
// deploys the web runtime closure into `runtime/node_modules` with
// `pnpm deploy`, mirroring the single-exe pipeline
// (scripts/build-exe-for-python-sdk.ts): a hoisted, prod-only, workspace-linked
// tree with no peer auto-install, so one flat Cordis instance is preserved.
//
// The closure content is defined once by the dependency-only workspace package
// `apps/vscode/runtime-deploy` (`dsh-web-runtime-closure`): its manifest lists
// every plugin the web profile and shipped agent presets load by bare name,
// plus the non-optional workspace peers Cordis needs under
// auto-install-peers=false, on top of the dsh CLI and the served frontend.
// Adding a distribution plugin means adding one dependency line there — the
// same model as python/sdk-runtime.
//
// pnpm's legacy hoister leaves a few vendored framework packages (overridden
// via link:vendor/* in pnpm-workspace.yaml) beside the deploy source instead
// of inside the target; they are copied back from vendor/ with symlinks
// dereferenced and nested node_modules excluded.
//
// The output is runtime-only: source maps, TypeScript sources, and test
// fixtures are pruned.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(root, '..', '..')
const runtimeDir = join(root, 'runtime')
const closureNodeModules = join(runtimeDir, 'node_modules')
// The dependency-only deploy root package (apps/vscode/runtime-deploy).
const deployManifestPath = join(root, 'runtime-deploy', 'package.json')

// Dependency-only workspace package whose production dependency graph IS the
// web kernel closure.
const DEPLOY_FILTER = 'dsh-web-runtime-closure'

// Vendored framework packages pnpm's legacy hoister omits from the deploy
// target: vendor directory name -> package name. Copied dereferenced.
const VENDOR_RESTORE = {
  cosmokit: '@deepseek-ai/cosmokit',
  group: '@deepseek-ai/cordis-plugin-group',
  'logger-console': '@deepseek-ai/cordis-plugin-logger-console',
  schemastery: '@deepseek-ai/schemastery',
}

// Runtime-only prune: never needed to boot the kernel. Directory names are
// limited to test/tooling dirs — `doc`/`docs` are NOT pruned because runtime
// packages ship code under those paths (e.g. yaml's dist/doc/directives.js).
const PRUNE_DIR_NAMES = new Set(['tests', 'test', '__tests__', '.turbo'])
// Type declarations are ~40% of the closure's file count and never load at
// runtime; pruning them keeps the VSIX extraction fast.
const PRUNE_FILE_SUFFIXES = ['.map', '.tsbuildinfo', '.d.ts', '.d.mts', '.d.cts']
const PRUNE_FILE_NAMES = new Set(['tsconfig.json', 'tsconfig.base.json', 'eslint.config.js'])

function runPnpm(args) {
  const execpath = process.env.npm_execpath
  const options = { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  if (execpath?.endsWith('.mjs')) {
    return execFileSync(process.execPath, [execpath, ...args], options)
  }
  return execFileSync('pnpm', args, { ...options, shell: process.platform === 'win32' })
}

/** Copy a vendored package into the closure, dereferencing symlinks and
 * skipping nested node_modules to avoid the vendor symlink cycles. */
function restoreVendorPackage(vendorDir, packageName) {
  const src = join(repoRoot, 'vendor', vendorDir)
  const dst = join(closureNodeModules, ...packageName.split('/'))
  const nestedNodeModules = join(src, 'node_modules')
  cpSync(src, dst, {
    recursive: true,
    dereference: true,
    filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
  })
}

/**
 * Copy declared dependencies pnpm's legacy hoister placed beside the deploy
 * source instead of in the target. The deploy root manifest supplies every
 * required package, so a missing target row is restored from
 * runtime-deploy/node_modules with symlinks dereferenced and nested
 * node_modules excluded (one flat tree). Fails loud if a source is missing too.
 * The source-side node_modules is then removed: it is deploy scratch, and the
 * links pnpm materializes there point back at workspace/vendor sources, so
 * leaving it would let later pruning reach out of the closure.
 * @param deployManifestPath - absolute path of the deploy root package.json.
 */
function restoreHoistedDependencies(deployManifestPath) {
  const sourceRoot = join(dirname(deployManifestPath), 'node_modules')
  const manifest = JSON.parse(readFileSync(deployManifestPath, 'utf8'))
  const restored = []
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/')) continue
    const dst = join(closureNodeModules, ...name.split('/'))
    // A link pnpm left at dst resolves only inside this checkout and pnpm pack
    // drops it; replace it with a real dereferenced copy like a missing row.
    if (existsSync(join(dst, 'package.json')) && !lstatSync(dst).isSymbolicLink()) continue
    rmSync(dst, { recursive: true, force: true })
    const src = join(sourceRoot, ...name.split('/'))
    if (!existsSync(join(src, 'package.json'))) {
      throw new Error(`build-runtime-closure: ${name} absent from both the closure and ${sourceRoot}`)
    }
    const nested = join(src, 'node_modules')
    cpSync(src, dst, {
      recursive: true,
      dereference: true,
      filter: path => path !== nested && !path.startsWith(nested + sep),
    })
    restored.push(name)
  }
  if (restored.length > 0) {
    console.log(`build-runtime-closure: restored ${restored.length} legacy-hoisted dependencies`)
  }
  rmSync(sourceRoot, { recursive: true, force: true })
}

/**
 * Recursively remove non-runtime files (maps, test fixtures, tsconfig) from a
 * REAL directory tree. Symlinks are never followed or pruned: pnpm's
 * node_modules entries link to the content-addressable store and workspace
 * sources, and deleting through them would damage the checkout. The deployed
 * closure is hoisted (real files, no per-package links), while restored vendor
 * copies were already dereferenced during the copy, so pruning real entries is
 * sufficient here.
 * @param dir - directory to prune in place.
 */
function pruneRuntimeTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (PRUNE_DIR_NAMES.has(entry.name)) {
        rmSync(full, { recursive: true, force: true })
        continue
      }
      pruneRuntimeTree(full)
    } else if (PRUNE_FILE_NAMES.has(entry.name) || PRUNE_FILE_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) {
      rmSync(full, { force: true })
    }
  }
}

/**
 * Fail loud if any entry in the closure is a symbolic link. A link resolves
 * only against this checkout (or is dropped outright by pnpm pack), so it
 * would make the installed closure fail exactly where the workspace one boots.
 * Windows junctions can surface as directories in readdir, so lstat each path.
 * @param dir - directory to walk.
 */
function assertSymlinkFree(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (lstatSync(full).isSymbolicLink()) {
      throw new Error(`build-runtime-closure: symlink left in closure: ${full}`)
    }
    if (statSync(full).isDirectory()) assertSymlinkFree(full)
  }
}

function directorySizeMb(dir) {
  let bytes = 0
  const walk = d => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else bytes += st.size
    }
  }
  walk(dir)
  return (bytes / 1024 / 1024).toFixed(1)
}

function main() {
  if (runtimeDir === repoRoot || repoRoot.startsWith(runtimeDir + sep)) {
    throw new Error(`build-runtime-closure: refusing to clear ${runtimeDir}: it contains the repo root.`)
  }
  console.log(`build-runtime-closure: deploying ${DEPLOY_FILTER} production closure into runtime/`)
  rmSync(runtimeDir, { recursive: true, force: true })
  mkdirSync(runtimeDir, { recursive: true })

  runPnpm([
    '--filter', DEPLOY_FILTER,
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    runtimeDir,
  ])

  for (const [vendorDir, packageName] of Object.entries(VENDOR_RESTORE)) {
    const dst = join(closureNodeModules, ...packageName.split('/'))
    // Deploy may materialize these as links to the checkout's vendor sources.
    // A link resolves only inside this checkout and pnpm pack drops it, so the
    // closure must always hold a dereferenced copy: replace whatever is there.
    rmSync(dst, { recursive: true, force: true })
    restoreVendorPackage(vendorDir, packageName)
    console.log(`build-runtime-closure: materialized vendor ${packageName}`)
  }

  // pnpm's legacy hoister also places some of the deploy root's direct
  // dependencies beside the deploy source (runtime-deploy/node_modules)
  // instead of inside the target. Restore every declared dependency still
  // missing from the closure by copying it dereferenced from there, excluding
  // the source's own nested node_modules (the closure keeps one flat tree).
  restoreHoistedDependencies(deployManifestPath)

  // The closure carries only the kernel payload, not extension host artifacts.
  for (const own of ['dist', 'media', 'scripts']) {
    rmSync(join(runtimeDir, own), { recursive: true, force: true })
  }

  pruneRuntimeTree(closureNodeModules)
  assertSymlinkFree(closureNodeModules)

  // Fail loud if the two anchors the kernel resolves are missing.
  const req = createRequire(join(runtimeDir, 'package.json'))
  const binPkg = req.resolve('@deepseek-ai/dsh/package.json')
  const frontend = req.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  if (!existsSync(join(dirname(binPkg), 'lib', 'bin.js'))) {
    throw new Error('build-runtime-closure: @deepseek-ai/dsh lib/bin.js missing from closure')
  }
  if (!existsSync(frontend)) {
    throw new Error('build-runtime-closure: @deepseek-ai/dsh-web-frontend dist/index.html missing from closure')
  }

  // Verify every plugin the deploy root declares is materialized; a missing
  // row fails the build rather than a packaged Cordis load.
  const deployManifest = JSON.parse(readFileSync(join(root, 'runtime-deploy', 'package.json'), 'utf8'))
  const missing = Object.keys(deployManifest.dependencies)
    .filter(name => name.startsWith('@deepseek-ai/'))
    .filter(name => !existsSync(join(closureNodeModules, ...name.split('/'), 'package.json')))
  if (missing.length > 0) {
    throw new Error(`build-runtime-closure: declared dependencies absent from closure: ${missing.join(', ')}`)
  }

  console.log(`build-runtime-closure: OK — ${directorySizeMb(closureNodeModules)} MB; bin, frontend, and all declared plugins resolvable`)
}

main()
