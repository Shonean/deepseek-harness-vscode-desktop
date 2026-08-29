#!/usr/bin/env node
// Build an installable .vsix from this package's publish tarball.
//
// The extension publishes through the repository's npm release-member policy
// (dist + runtime + media payload), so the VSIX must carry exactly what the
// published tarball carries — not whatever sits in the working tree. This
// script packs the tarball first, unpacks it into the `extension/` folder of
// a VSIX layout, synthesizes the two XML control files, and zips the result
// with fflate's batch zipSync. The batch API is required: the streaming Zip
// state machine corrupted entries (bad CRC on 3 of ~12.6k) at this entry
// count, and every packed archive is verified with unzipSync so a bad artifact
// fails the build instead of reaching an installer.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, zipSync } from 'fflate'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const outPath = join(root, 'dist', `dsh-vscode-${pkg.version}.vsix`)

// A stale .vsix sitting in dist/ would be packed into the tarball and end up
// nested inside the fresh artifact; drop it before packing.
rmSync(outPath, { force: true })

// pnpm names the tarball with the scope flattened in (`@deepseek-ai/dsh-vscode`
// -> `deepseek-ai-dsh-vscode-<version>.tgz`). The pack stdout lists every file
// (the runtime closure makes it ~100k lines), too large for an execFileSync
// pipe buffer, so stdout inherits the console and the tarball is located by
// name after clearing stale ones.
const stagedName = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`
for (const stale of readdirSync(root).filter(f => f.endsWith('.tgz'))) {
  rmSync(join(root, stale), { force: true })
}
runPnpm(['pack', '--pack-destination', root], ['ignore', 'inherit', 'inherit'])
if (!readdirSync(root).includes(stagedName)) {
  throw new Error(`pnpm pack did not produce ${stagedName} in ${root}`)
}
const packed = stagedName
const tarball = join(root, packed)

const stage = mkdtempSync(join(tmpdir(), 'dsh-vsix-'))

// Inside a `pnpm run` script, npm_execpath points at pnpm's own .mjs entry;
// running it through node avoids Windows' inability to exec .mjs files
// directly. Outside a pnpm script, fall back to the shell-resolved command.
function runPnpm(args, stdio = ['ignore', 'pipe', 'inherit']) {
  const execpath = process.env.npm_execpath
  const options = { cwd: root, encoding: 'utf8', stdio }
  if (execpath?.endsWith('.mjs')) {
    return execFileSync(process.execPath, [execpath, ...args], options)
  }
  return execFileSync('pnpm', args, { ...options, shell: process.platform === 'win32' })
}
async function pack() {
  const unpacked = join(stage, 'unpacked')
  const extensionDir = join(stage, 'extension')
  mkdirSync(unpacked)
  execFileSync('tar', ['-xzf', tarball, '-C', unpacked], { stdio: 'inherit' })
  // npm tarballs wrap the payload in a single top-level `package/` folder;
  // inside a VSIX that folder is named `extension/`.
  cpSync(join(unpacked, 'package'), extensionDir, { recursive: true })

  // The npm package name is scoped, but VSCode derives the on-disk extension
  // folder from the manifest name and cannot handle the separator; the
  // marketplace identity is already unscoped (`publisher.name`), so rewrite
  // the staged copy to match.
  const stagedPkgPath = join(extensionDir, 'package.json')
  const stagedPkg = JSON.parse(readFileSync(stagedPkgPath, 'utf8'))
  stagedPkg.name = pkg.name.split('/').pop()
  writeFileSync(stagedPkgPath, JSON.stringify(stagedPkg, null, 2))

  // Build the whole archive in memory. The runtime closure makes the input
  // ~120 MB and the output ~40 MB; both fit comfortably in a packing script,
  // and zipSync is the fflate code path with no streaming state machine.
  const files = {
    '[Content_Types].xml': strToU8(buildContentTypes(extensionDir)),
    'extension.vsixmanifest': strToU8(buildManifest(pkg)),
  }
  let totalBytes = 0
  walk(extensionDir, (file) => {
    const relative = file.slice(extensionDir.length + 1).replaceAll('\\', '/')
    const data = new Uint8Array(readFileSync(file))
    totalBytes += data.length
    files[`extension/${relative}`] = data
  })
  mkdirSync(join(root, 'dist'), { recursive: true })
  const zipped = zipSync(files, { level: 9 })
  writeFileSync(outPath, zipped)

  // Verify the artifact before declaring success: unzipSync throws on any
  // CRC or structure mismatch, so a corrupted entry fails the build here.
  const verified = unzipSync(zipped)
  const verifiedEntries = Object.keys(verified).length
  if (verifiedEntries !== Object.keys(files).length) {
    throw new Error(`pack-vsix: verification found ${verifiedEntries} entries, packed ${Object.keys(files).length}`)
  }
  console.log(`wrote ${outPath} (${(totalBytes / 1024 / 1024).toFixed(1)} MB packed, ${verifiedEntries} entries verified)`)
}

try {
  await pack()
} finally {
  rmSync(stage, { recursive: true, force: true })
  rmSync(tarball, { force: true })
}

function buildContentTypes(extensionDir) {
  const extensions = new Set()
  walk(extensionDir, (file) => {
    const ext = basename(file).split('.').pop().toLowerCase()
    if (ext && ext !== basename(file)) extensions.add(ext)
  })
  const defaults = [...extensions]
    .map((ext) => `  <Default Extension="${ext}" ContentType="${contentTypeFor(ext)}"/>`)
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${defaults}
</Types>
`
}

function contentTypeFor(ext) {
  if (ext === 'json') return 'application/json'
  if (ext === 'svg') return 'image/svg+xml'
  if (['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`
  if (['js', 'cjs', 'mjs'].includes(ext)) return 'application/javascript'
  return 'application/octet-stream'
}

function buildManifest(pkg) {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name.split('/').pop()}" Version="${pkg.version}" Publisher="${pkg.publisher}"/>
    <DisplayName>${escapeXml(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(pkg.description)}</Description>
    <Categories>${pkg.categories.join(',')}</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
`
}

function escapeXml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, visit)
    else visit(path)
  }
}

function strToU8(text) {
  return new TextEncoder().encode(text)
}
