# Agent Note: Unofficial branding for the community VSCode extension and desktop shell

Status: implemented

English | [中文](2026-08-28-vscode-desktop-brand-compliance.zh.md)

## Problem

The community-published VSCode extension (`apps/vscode`) and desktop shell (`apps/desktop`) shipped under upstream identity: extension publisher `deepseek-ai`, display name and command titles containing the full "DeepSeek Harness" trademark, desktop appId `ai.deepseek.harness.desktop`, and repository URLs pointing at the upstream org. [BRAND_GUIDELINES.md](../../../BRAND_GUIDELINES.md) directs community projects to use the abbreviated "DSH" designation in names, avoid the full trademark in project/extension names, and avoid any impression of official endorsement. The user approved: publisher `shonean`, extension display name "DSH for VS Code", desktop "DSH Desktop" / `com.shonean.dsh-desktop`, with the pink whale icon kept (a noted, user-accepted deviation).

## Decision

Apply the guideline surface-by-surface, keeping "DeepSeek Harness" only in truthful descriptive text:

- VSCode manifest: publisher `shonean`, displayName `DSH for VS Code`, description prefixed "Unofficial community build."; activity-bar container title, command titles (`DSH: Open DSH Panel`, `DSH: New DSH Session`, `DSH: Close DSH Panel`, `DSH: Show DSH Logs`), configuration title, and output-channel name use "DSH"; repository URL points at the community fork; `keywords` includes `dsh-plugin`.
- User-visible strings in extension host code (panel title, progress notification, sidebar/webview document titles, log channel) use "DSH".
- Desktop: package `productName` `DSH Desktop`; electron-builder `appId: com.shonean.dsh-desktop`, portable artifact `DSH-Desktop-<version>.exe`; window title, notifications, tray tooltip, Windows AppUserModelId, and the packaging script follow; repository URL points at the fork.
- Both READMEs (en/zh) rewritten user-facing: badges (unofficial / upstream / license), an explicit unofficial-maintainer disclaimer with the trademark statement, install steps, and requirements.
- The npm package names stay `@deepseek-ai/dsh-vscode` / `@deepseek-ai/dsh-desktop` because the workspace naming convention (`@deepseek-ai/dsh-*`) is internal and the VSIX packer already rewrites the staged manifest name to unscoped `dsh-vscode`; marketplace identity is `publisher.name` = `shonean.dsh-vscode`.
- The SPA's own in-product branding (web manifest name, system prompt, snapshot fixtures) is upstream project content and is untouched.

## Alternatives considered

- Renaming the npm packages (`@deepseek-ai/dsh-vscode` → an unscoped or `shonean`-scoped name) was considered and rejected: the workspace naming convention is internal identity, the VSIX packer already unstages the name to `dsh-vscode`, and the marketplace identity is `publisher.name`; a rename would churn every workspace reference for no user-visible effect.
- Replacing the pink whale icon with a neutral mark to fully match the guidelines was considered and rejected by explicit user decision; the deviation is recorded above.
- Keeping the full "DeepSeek Harness" name with a disclaimer prefix was rejected: the guidelines specifically direct names toward "DSH", and marketplace/display names are the surface most likely to imply official endorsement.

## Consequences

- The installed extension identity is `shonean.dsh-vscode`; the old `deepseek-ai.dsh-vscode` entry (if present) must be uninstalled to avoid two same-name extensions. Repacked VSIX verified: manifest shows Publisher `shonean`, DisplayName `DSH for VS Code`; real-machine install succeeds and the kernel boot + SPA root resolve from the installed extension (junction to the workspace `node_modules` still required — the runtime-closure VSIX gap is separately tracked).
- Branding lives in manifests, host code strings, and READMEs — no plugin or wire changes; app unit suites (99 tests), tsc, and oxlint stay green; translation pairing re-recorded for both README pairs.
- The pink whale icon remains the extension/desktop icon by explicit user decision; this is the one guideline-adjacent deviation and is recorded here rather than silently kept.
- Release/promotion artifacts (Discussions show-and-tell and Discord self-intro drafts) accompany this change as community-facing text, not repository content.
