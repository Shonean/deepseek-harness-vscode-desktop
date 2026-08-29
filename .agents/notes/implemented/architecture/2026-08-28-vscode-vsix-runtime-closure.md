# Agent Note: The VSIX ships a self-contained kernel runtime closure

Status: implemented

English | [中文](2026-08-28-vscode-vsix-runtime-closure.zh.md)

## Problem

The packaged VSIX carried only the extension bundle and media. On a clean machine the kernel could not boot: `resolveDshBin` resolves `@deepseek-ai/dsh` from the extension folder, but an installed VSIX has no `node_modules` beside it, and the kernel's bundled `cordis.yml` loads web-profile plugins by bare package name, so every such resolution failed. The working workaround was a manual junction from `~/.vscode/extensions/node_modules` to a built checkout's `apps/vscode/node_modules` — an install step impossible to ask of users, and one that disappears on every upgrade.

## Decision

The VSIX carries a pnpm-deploy production closure under `extension/runtime/`, and resolution prefers it.

- A new dependency-only workspace package `apps/vscode/runtime-deploy` (`dsh-web-runtime-closure`) declares the closure content: its dependency manifest is exactly the web kernel — the `dsh` CLI, the served web frontend, every plugin the web profile and shipped agent presets load by bare name, and the non-optional workspace peers Cordis requires with `auto-install-peers=false`. Adding a distribution plugin means adding one dependency line there, mirroring the python-sdk runtime model.
- `scripts/build-runtime-closure.mjs` materializes it with `pnpm deploy --legacy --prod --node-linker=hoisted --auto-install-peers=false --link-workspace-packages=true` into `apps/vscode/runtime/`, materializes the vendored framework packages pnpm may leave as links to the checkout's vendor sources as dereferenced real copies (and likewise replaces any declared dependency the deploy left behind as a link), prunes non-runtime files (source maps, `.d.ts`, `tsconfig.json`, test directories), fails loud if the `dsh` bin, the frontend `dist/index.html`, or any declared plugin is missing from the closure, and fails loud if any symlink survives in the closure: a link resolves only inside this checkout and pnpm pack drops it, so the workspace closure boots while the installed one crashes with `ERR_MODULE_NOT_FOUND`.
- The package `files` field adds `runtime/node_modules/**` and `runtime/package.json`, so the publish tarball — and therefore the VSIX built from it by `scripts/pack-vsix.mjs` — carries the closure; `pack:vsix` chains `build` + closure materialization + pack.
- `src/runtime-resolution.ts` anchors a `createRequire` at `runtime/package.json` when the closure exists and falls back to the extension `package.json` in source checkouts; `kernel.ts` logs `resolvedFrom=` with the winning root, so an installed state is diagnosable from the output channel. The kernel still boots on the system Node ([kernel-node-resolution note](../bug-fix/2026-08-27-dsh-vscode-kernel-node-resolution.md)); only dependency resolution changed.

## Alternatives considered

- Shipping `node_modules` from the workspace checkout directly (`files: ["node_modules/**"]`) was rejected: pnpm's symlinked workspace layout does not survive tarball packing, and the closure would track whatever the working tree happens to contain instead of a declared production graph.
- Bundling the kernel with esbuild into the extension bundle was rejected: the kernel is a separate Node process with dynamic bare-name plugin loading; bundling would fork it from the CLI packaging and break the resolver manifest contract.
- Keeping the junction requirement was rejected outright: it cannot be part of a user-facing install.

## Consequences

- A clean install needs no junction: the kernel and the SPA boot from the installed closure (`resolvedFrom=` ends in `runtime`).
- The VSIX grows from ~0.2 MB to ~40 MB compressed (~120 MB extracted, ~12.6k files after `.d.ts` pruning), and installing it takes noticeably longer; the README states this under Known limitations.
- The closure is one flat hoisted tree with workspace links dereferenced, preserving a single Cordis instance; pruning never follows symlinks, so it cannot reach outside the closure into the checkout.
- Desktop portable packaging can reuse the same `runtime/` closure directory when it ships its own payload; nothing in the closure build is VSIX-specific.
- The first closure VSIX packed with fflate's streaming `Zip` corrupted three entries; the packer now uses batch `zipSync` with a mandatory read-back verification ([zip-corruption note](../bug-fix/2026-08-28-vscode-vsix-streaming-zip-corruption.md)).
- Verification: closure probe green (bin and frontend resolve from `runtime/`, kernel prints its URL, `/` and `/plugins/...` answer 200); after the fixes, the installed closure (extracted from the VSIX, no junction) boots the real kernel from a workspace-external cwd — the standalone host-sim replica created a session and reached `kernel: listening`, as does a bare `node <closure>/lib/bin.js --profile web`; all 12,650 files on disk. `apps/vscode` unit tests, tsc, and oxlint green. Caveat: the vitest `host-sim.spec.ts` passed even against the broken pre-fix closure — the same import graph that fails under a bare spawn resolves inside the vitest worker environment, cause unidentified — so installed-state verification must not rely on the vitest harness alone until that is understood.
