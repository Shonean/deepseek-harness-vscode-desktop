// electron-builder afterPack hook.
// Repairs the packaged node_modules after electron-builder copies it:
// electron-builder's pnpm collector drops `link:` workspace packages and some
// package entry files (e.g. dsh-atomic-write/lib/index.js), and copies pnpm
// internal symlinks that a stock Node cannot follow. This hook completes the
// @deepseek-ai scope from the repository sources and dereferences symlinks.
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, readlinkSync,
} from 'node:fs'
import { join } from 'node:path'

export default async function afterPack(context) {
  const app = join(context.appOutDir, 'resources', 'app')
  const projectDir = context.packager?.projectDir ?? context.appOutDir
  const root = join(projectDir, '..', '..')
  const dest = join(app, 'node_modules', '@deepseek-ai')
  mkdirSync(dest, { recursive: true })

  const pkgName = (p) => {
    try { return JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).name } catch { return undefined }
  }

  // name -> best repository source (.pnpm first, then vendor/, then packages/)
  const byName = new Map()
  const pnpm = join(root, 'node_modules', '.pnpm')
  if (existsSync(pnpm)) {
    for (const d of readdirSync(pnpm)) {
      const m = d.match(/^(@deepseek-ai\+)([^@]+)@/)
      if (!m) continue
      const p = join(pnpm, d, 'node_modules', '@deepseek-ai', m[2])
      if (existsSync(p)) byName.set('@deepseek-ai/' + m[2], p)
    }
  }
  for (const base of ['vendor', 'packages', 'apps']) {
    const bdir = join(root, base)
    if (!existsSync(bdir)) continue
    for (const a of readdirSync(bdir)) {
      if (base === 'apps' && a === 'desktop') continue // the app being packaged (self-copy guard)
      const sub = join(bdir, a)
      const dirs = base === 'packages'
        ? (() => { try { return statSync(sub).isDirectory() ? readdirSync(sub).map((b) => join(sub, b)) : [] } catch { return [] } })()
        : [sub]
      for (const p of dirs) {
        if (!existsSync(p) || !statSync(p).isDirectory()) continue
        const n = pkgName(p)
        if (n) byName.set(n, p)
      }
    }
  }

  const copyPkg = (src, t) => {
    rmSync(t, { recursive: true, force: true })
    mkdirSync(t, { recursive: true })
    cpSync(src, t, { recursive: true, filter: (s) => !s.split(/[\\/]/).includes('node_modules') })
  }

  // 1. Add every @deepseek-ai package from the repository that is missing or
  //    broken in the packaged app (electron-builder drops `link:` workspace
  //    packages entirely, or copies them without their entry files).
  let rebuilt = 0
  for (const [name, src] of byName) {
    const bare = name.startsWith('@deepseek-ai/') ? name.slice('@deepseek-ai/'.length) : name
    const t = join(dest, bare)
    const pj = join(t, 'package.json')
    let need = !existsSync(t)
    if (!need && !existsSync(pj)) need = true
    if (!need) {
      try {
        const j = JSON.parse(readFileSync(pj, 'utf8'))
        if (j.main && !existsSync(join(t, j.main))) need = true
      } catch { need = true }
    }
    if (need) { copyPkg(src, t); rebuilt++ }
  }

  // 2. Replace symlinks (Git Bash style targets) with real copies
  let links = 0
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) {
        const t = readlinkSync(p).replace(/^\/([cd])\//, '$1:/')
        if (existsSync(t)) {
          const tmp = p + '.real'
          cpSync(t, tmp, { recursive: true, filter: (s) => !s.split(/[\\/]/).includes('node_modules') })
          rmSync(p, { recursive: true, force: true })
          renameSync(tmp, p)
          links++
        }
      } else if (e.isDirectory()) {
        walk(p)
      }
    }
  }
  walk(join(app, 'node_modules'))

  console.log(`[afterPack] repaired ${rebuilt} package(s), dereferenced ${links} symlink(s)`)
}
