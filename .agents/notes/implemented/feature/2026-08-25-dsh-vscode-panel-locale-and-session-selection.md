# Agent Note: dsh-vscode panel locale switching and session selection feedback

Status: implemented

English | [中文](2026-08-25-dsh-vscode-panel-locale-and-session-selection.zh.md)

## Problem

The chat panel rendered only English strings, so Chinese-locale users worked in a foreign UI. Separately, clicking the panel's new-session button appeared to do nothing: the host created the session but the `sessions` message carried no active-session id, so the webview neither selected the new entry nor distinguished it from existing identically-titled ones.

## Decision

The panel localizes through a setting: `dsh-vscode.uiLocale` accepts `auto`, `en`, or `zh-cn` (`auto` resolves against VSCode's display language). The host resolves the concrete locale once at activation and on every settings change, injects both string tables plus the active locale into the webview document ahead of its script, and re-renders the document when the setting changes. Static markup is generated per locale by an exported pure `buildChatHtml(webview, locale)`; the embedded tables keep both languages available to the script with an English fallback.

Session selection became explicit host state on the wire: `ready` carries `activeSessionId` and every `sessions` message carries `activeId`, and the webview adopts it before rendering. Creating a session now visibly switches to it.

## Alternatives considered

**VSCode's `@vscode/l10n` with `package.nls.*.json`.** Localizes command titles and settings descriptions against VSCode's display language, but it cannot offer a per-extension free choice — the language follows the editor — and it does not reach webview DOM strings without duplicating the lookup there. The panel-owned table keeps one mechanism for both requirements; adopting l10n later for manifest strings can layer on top unchanged.

**Rebuilding the string tables per locale server-side (one table injected).** Smaller payload, but a locale switch then requires regenerating the HTML anyway while losing the script's ability to fall back mid-render; embedding both tables costs under 1 KB and makes the rendered locale the only variable.

**Auto-selecting nothing after creation (keep manual selection).** Preserves the old no-switch behavior for users who batch-create sessions, but every existing consumer of the button expects to land in the fresh chat; the select dropdown still allows switching back in one click.

## Consequences

Adding a UI string means adding one key to both tables in `chat-view.ts`; TypeScript rejects a missing key, and `tests/chat-html.spec.ts` pins the zh-cn surface, the en surface's static markup, dual-table embedding, and nonce coverage. Locale changes reload the webview, clearing transient transcript state by design. Command-palette titles remain English until manifest-level localization is added.
