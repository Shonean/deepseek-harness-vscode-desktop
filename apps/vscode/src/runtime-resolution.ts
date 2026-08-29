import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Resolve the kernel runtime anchors. A packaged VSIX carries a self-contained
 * production closure under `<extension>/runtime/` (materialized by
 * scripts/build-runtime-closure.mjs via `pnpm deploy`): the dsh CLI, every
 * web-profile plugin, and the served frontend dist. The closure is resolved
 * first so a clean install — one with no workspace `node_modules` beside the
 * extension — still boots. A source checkout has no `runtime/`, so resolution
 * falls back to the workspace `node_modules` linked next to the extension.
 * @module runtime-resolution
 */

/** Subdirectory of the extension that holds the deployed runtime closure. */
const CLOSURE_DIR = 'runtime'

/**
 * Build a require rooted at the closure package.json when the closure is
 * present, otherwise one rooted at the extension package.json (workspace
 * node_modules). Returns the root path the require was created from, so callers
 * can log which resolution path won.
 * @param extensionRoot - the installed extension directory.
 * @returns the require function and the root it was anchored at.
 */
function runtimeRequire(extensionRoot: string): { req: NodeJS.Require; root: string } {
  const closurePackage = join(extensionRoot, CLOSURE_DIR, 'package.json')
  if (existsSync(closurePackage)) {
    return { req: createRequire(closurePackage), root: join(extensionRoot, CLOSURE_DIR) }
  }
  return { req: createRequire(join(extensionRoot, 'package.json')), root: extensionRoot }
}

/**
 * Resolve the built `dsh` CLI bin entry (`lib/bin.js`), closure first.
 * @param extensionRoot - the installed extension directory.
 * @returns absolute path to the kernel bin and the resolution root.
 */
export function resolveDshBin(extensionRoot: string): { bin: string; root: string } {
  const { req, root } = runtimeRequire(extensionRoot)
  const pkgJson = req.resolve('@deepseek-ai/dsh/package.json')
  return { bin: join(dirname(pkgJson), 'lib', 'bin.js'), root }
}

/**
 * Resolve the built web frontend `dist/index.html`, closure first.
 * @param extensionRoot - the installed extension directory.
 * @returns absolute path to the frontend index and the resolution root.
 */
export function resolveFrontendIndex(extensionRoot: string): { index: string; root: string } {
  const { req, root } = runtimeRequire(extensionRoot)
  return { index: req.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'), root }
}
