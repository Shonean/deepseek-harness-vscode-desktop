# Agent Note: dsh VSIX packs from the publish tarball

Status: implemented

English | [中文](2026-08-25-dsh-vscode-vsix-from-publish-tarball.zh.md)

## Problem

`@deepseek-ai/dsh-vscode` ships as an npm release member, but editor users install a `.vsix` file. The standard `@vscode/vsce` pipeline packs the working tree under its own include rules, so the installable artifact and the published tarball would be two independently derived payloads that can drift: a VSIX built by vsce can carry files the release policy excludes or omit files it requires. The extension also had no real-API test of the exact runtime composition it bundles.

## Decision

`pack:vsix` (`apps/vscode/scripts/pack-vsix.mjs`) builds the VSIX from the publish tarball. `pnpm pack` produces the exact npm payload; the script unpacks its `package/` folder as the VSIX `extension/` directory, synthesizes `[Content_Types].xml` and `extension.vsixmanifest`, and zips the result with `fflate` to `dist/dsh-vscode-<version>.vsix`. The staged manifest name is rewritten from the scoped package name to `dsh-vscode`: VSCode derives the on-disk extension folder from the manifest name, which cannot contain the scope separator, while the marketplace identity in `publisher.name` is already unscoped. Two guards keep a stale artifact out of itself: the `files` field excludes `dist/**/*.vsix` from the tarball, and the script deletes the previous output before packing.

The app also gains one real-API e2e, `apps/vscode/tests/openrouter-runtime.e2e.ts`: it boots the bundled `runtime/cordis.yml` under tsx, completes one turn through the OpenRouter route over stdio JSON-RPC (`initialize` → `session/prompt` → assistant text → `turn/end`), and asserts clean shutdown. The key resolves from `OPENROUTER_API_KEY`, then opencode's own logged-in record at `~/.local/share/opencode/auth.json`; the suite self-skips when neither exists, like every real-API e2e. The route mounts through the settings seam (`llm-pi-ai.providers.openrouter`), the same path a user preset takes, instead of editing the bundled composition.

## Alternatives considered

**Pack with `@vscode/vsce`.** The official tool validates manifests against marketplace rules and is what a future marketplace listing would use, but it packs the working tree, so the VSIX stops being derived from the released payload, and it adds a globally installed tool to the release path. Building from the tarball keeps one source of truth; adopting vsce later still works on top of the same tarball discipline if marketplace publishing arrives.

**Ship the tarball only and document manual installation.** No packaging code to own, but every user installation then hand-repeats the unpack-and-zip steps, and nothing verifies that the published payload installs into VSCode at all. The scripted VSIX makes installability a checked product surface.

**Key the e2e on `DEEPSEEK_API_KEY`.** Reusing the repo-wide key variable avoids a second credential source, but the OpenRouter route is exactly what the extension's preset flow configures for non-official providers, and the DeepSeek route is covered by the existing suites. Reading opencode's login record tests the route users actually run without storing another secret.

## Consequences

`fflate` becomes a devDependency of the app and the VSIX build runs wherever `pnpm pack` does — no platform tooling beyond Node and `tar`. Every re-pack requires the version to move or the output to be deleted first; the script handles the same-version case itself. The e2e model must satisfy two constraints: membership in pi-ai's installed catalog (`UNKNOWN_MODEL` otherwise) and reachability from the running region — OpenAI-hosted models answer 403 "not available in your region", and free variants retire frequently, so the test pins `cohere/north-mini-code:free` and accepts free-tier rate-limit flakiness through the shared vitest retry.
