# Agent Note: dsh-vscode kernel must boot on a real node, not the extension host execPath

Status: implemented

English | [中文](2026-08-27-dsh-vscode-kernel-node-resolution.zh.md)

## Problem

`dsh.openChat`/`dsh.newSession` in the real extension host died with `web kernel exited before listening (code 1)`. `startWebKernel` spawned `process.execPath`, which inside the extension host is Electron (`Code.exe`). Spawned bare, Electron treats the kernel CLI flags as Chromium switches and exits; under `ELECTRON_RUN_AS_NODE=1` it reaches the CLI but its ESM resolver rejects the loader's bare workspace specifiers (`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-client-ui-goal'` across ten-odd include-group imports) that plain node resolves through the same pnpm layout. The unit suite covered only the pure helpers, so the failure surfaced only in the host.

## Decision

`apps/vscode/src/kernel.ts` now resolves the kernel runtime in order: `DSH_NODE_EXE` override, first `node`/`node.exe` on `PATH` (pure `nodeSearchCandidates` derives per-platform candidates), then the host execPath as last resort. `ELECTRON_RUN_AS_NODE=1` stays set unconditionally: it is what makes the fallback viable, and plain node ignores it. The platform split of the PATH parser is pinned by unit tests.

## Alternatives considered

**Keep `process.execPath` with the flag only.** The negative control reproduces the crash and the flag-only path reproduces the resolver failure, so the host runtime is disqualified as the kernel launcher regardless of flags.

**Reuse the deleted runtime-resolver plugin.** The T4 refactor removed it along with the preset machinery it served; a single resolution order inside `kernel.ts` covers the one remaining consumer without restoring that layer.

## Consequences

Kernel startup depends on a node being reachable through `PATH` (or `DSH_NODE_EXE`), the normal condition for dsh users; when nothing is found, the fallback still boots and its stderr carries the true failure instead of the Electron GUI exit. Verification from the installed extension directory: junctioned `node_modules`, kernel URL line, SPA index fetch, two `session.create` calls, and `session.list` all pass with plain node.
