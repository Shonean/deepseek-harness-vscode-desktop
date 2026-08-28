# Agent Note: dsh-vscode bundle export interop breaks activation when footered

Status: implemented

English | [中文](2026-08-25-dsh-vscode-bundle-export-interop.zh.md)

## Problem

The installed `dsh-vscode` extension never opened its sidebar view: every activation died with `TypeError: Cannot set property activate of #<Object> which has only a getter` thrown while loading `dist/extension.cjs`. The bundle's footer reassigned `module.exports.activate`, but esbuild 0.25's CJS entry output already defines the entry's ESM named exports as getter-only properties through `__export`, and the assignment throws under the bundle's `"use strict"`. No test loaded the built bundle, so the failure only surfaced in the real extension host.

## Decision

`apps/vscode/scripts/build.mjs` no longer appends an export footer: esbuild's own named-export annotation is what the extension host requires, and `require('dist/extension.cjs')` exposes `activate`/`deactivate`. A keyless unit suite (`apps/vscode/tests/bundle-activation.spec.ts`) loads the built bundle through Node's CJS loader with a stubbed `vscode` module and asserts both hooks are functions, pinning the load-time contract the host exercises on every activation.

## Alternatives considered

**Keep the footer but assign via `defineProperty` or delete-then-set.** Preserves the historical code shape while defeating the getter, but the footer's premise is stale — esbuild already lands the exports — so the correct minimal change is deletion, not a second workaround layered over working output.

**Add a startup activation event so failures surface without clicking.** Activation-on-startup would have made the breakage visible earlier in logs, but it starts the runtime subprocess machinery eagerly for users who never open the view; the regression test covers the same layer deterministically without changing activation semantics.

## Consequences

Reproducing activation regressions no longer requires launching VSCode: the unit suite runs wherever `dist/extension.cjs` exists and self-skips on an unbuilt tree. Upgrading or replacing esbuild must keep the property that CJS entry output lands ESM named exports on `module.exports`; the suite fails immediately if that changes.
