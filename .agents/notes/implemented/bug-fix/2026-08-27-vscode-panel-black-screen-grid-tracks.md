# Agent Note: Embedded-panel black screen came from a three-track grid with two children

Status: implemented

English | [中文](2026-08-27-vscode-panel-black-screen-grid-tracks.zh.md)

## Problem

The VSCode panel rendered black ("loading animation, then nothing") while the
SPA inside was demonstrably healthy. Every layer checked out: the tunnel's
WebSocket downlinks opened, every startup RPC returned 200, the boot probes
reported all scripts loaded, and a DOM self-check inside the webview reported
the hero view rendered with correct colors, dimensions, and layout. The panel
iframe had a normal 1349×918 rect on screen. Even software rendering
(`--disable-gpu`) stayed black. Claude Code's panel in the same VSCode was
fine. The symptom pointed everywhere except the actual bug.

## Decision

Root cause: `AppFrame`'s embedded mode rendered two grid children (center + details —
the sidebar column is skipped) but kept the three-track
`grid-template-columns` from the normal mode (`0px minmax(0, 1fr) 0px`).
Grid auto-placement put the center column (the whole hero/conversation
surface) into the zero-width first track, and the details column — an empty,
transparent, full-`1fr` track — covered the viewport. The page was perfectly
rendered; it was just placed off-screen, with a transparent column on top.
The fix: embedded mode emits a two-track template
(`minmax(0, 1fr) ${details}px`), which places the center first.

## Alternatives considered

No alternative fixes were in play — the root cause was found after the
diagnostics probe pointed at the covering details column, and the fix is the
minimal template change above. What *was* considered and rejected along the
way are alternative *explanations*: the tunnel WebSocket relay (proven
working by open logs and RPC 200s), a CSP-blocked stylesheet (disproven by
computed light-on-dark colors inside the webview), the GPU compositor
(disproven by `--disable-gpu` still black), and a covering application
overlay (disproven until it turned out to be the grid itself).

## Consequences

- The panel shows the hero/conversation surface again.
- **Diagnostic discipline**: unit tests asserted the template *string* but
  not the *layout*; the headless simulator asserted DOM text but not what the
  viewport center hit. Both missed this. The lesson: when "DOM is fine but
  the screen is blank", probe `document.elementFromPoint(center)` and any
  element whose rect covers ≥90% of the viewport — that is exactly how the
  full probe found `center=DIV.detailsCol` covering the screen.
- The panel gained a comprehensive diagnostics probe (DOM shape, covering
  overlays, viewport-center element, CSS sheet load state, captured JS
  errors, focus, computed styles) sampled at 8s/25s/50s — the tool that
  turned a multi-hour hunt into a one-line answer.
- The probe template must stay pure JS: two earlier versions shipped
  TypeScript syntax (`frames[0]!`, `(): void`) into the browser string and
  died with `Unexpected token '!'` / `')'`, silently killing their own
  reporting. The template now carries an explicit "no TypeScript syntax"
  comment.
