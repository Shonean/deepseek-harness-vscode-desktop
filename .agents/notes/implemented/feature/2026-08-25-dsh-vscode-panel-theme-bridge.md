# Agent Note: VSCode panel follows the active color theme

Status: implemented

English | [中文](2026-08-25-dsh-vscode-panel-theme-bridge.zh.md)

## Problem

The web SPA resolves its `system` theme preference exclusively through
`matchMedia('(prefers-color-scheme: dark)')` — once at first paint
(`boot-theme.ts` injects a body inline script) and then via live media-query
updates in the client runtime. Inside a VSCode webview, that query reports the
host environment's preference, not VSCode's active color theme. The panel
could therefore render dark inside a light VSCode (or the reverse), and
switching VSCode themes would never reach the SPA.

## Decision

The extension bridges the seam the SPA already uses, rather than re-styling
the SPA. `webview-index.ts` exports a pure `themeBridgeScript(initialKind)`
that overrides `window.matchMedia` for the two color-scheme queries, answering
from the VSCode theme kind (`light` | `dark` | `hc-light` | `hc-dark`, mapped
from `ColorThemeKind`); all other queries delegate to the native
implementation, and the override re-dispatches change events so the SPA's live
theme runtime keeps working. `web-panel.ts` injects the script ahead of the
SPA with the current theme kind at render time, and pushes live updates
through `window.onDidChangeActiveColorTheme` as `dsh.vscodeTheme` messages the
bridge listens for.

## Alternatives considered

**Reacting to VSCode's `body.vscode-dark` classes with injected CSS.**
Re-colors static chrome but cannot drive the SPA's own `matchMedia` logic;
the SPA would still boot in the wrong scheme and its runtime toggles would
stay disconnected.

**Polling or DOM-mutation watching for theme changes.** Fragile and
duplicative; VSCode already offers an explicit
`onDidChangeActiveColorTheme` event, which is the single source of truth.

**Leaving the SPA on `system`.** The panel would follow the OS, drifting from
the editor the user is actually working in; the VSCode form factor demands
the panel match the editor.

## Consequences

- The panel renders in the same scheme as VSCode at first paint and tracks
  theme switches live, including High Contrast variants.
- The override is scoped to the two color-scheme queries only; any other
  media-query consumer in the SPA is unaffected.
- The bridge lives in the pure `webview-index.ts` surface, pinned by unit
  tests in `tests/webview-index.spec.ts` (dark/light answers, no delegation of
  color-scheme queries, delegation of others, flip-and-dispatch on a host
  theme message).
