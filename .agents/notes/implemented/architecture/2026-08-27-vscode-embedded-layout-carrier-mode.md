# Agent Note: Embedded-carrier mode hides the SPA's own session column

Status: implemented

English | [中文](2026-08-27-vscode-embedded-layout-carrier-mode.zh.md)

## Problem

The VSCode extension embeds the full web SPA in an editor panel
([tunnel note](2026-08-25-vscode-web-spa-tunnel.md)) beside the slim
activity-bar sidebar. The SPA carries its own session-management chrome — the
ui-sidebar rail with its New-session capsule and the ui-workspace browser — so
a VSCode window showed two "New session" buttons and two session lists with
independent state sources (the host broker's 2s poll vs the SPA's client
store). The user directive is Claude Code's arrangement: exactly one
session surface, and it lives in VSCode's left column.

## Decision

The layout shell, not composition, owns embeddedness. `createLayoutStore`
reads the same carrier marker the extension's transport half installs before
shell boot (`window.__DSH_TRANSPORT__`, the fact
[client-web boot](../../../packages/client/web/src/boot.ts) already keys on)
and freezes an `embedded` flag into the store at creation. In that mode
AppFrame:

- renders no sidebar column, no sidebar slot call, and no sidebar drag handle;
- solves columns through `computeEmbeddedColumns` — the shared concession
  chain from a zero-width sidebar start, so the center starts at the full
  frame and details keeps its shrink/auto-close behavior unchanged;
- skips the narrow auto-collapse machinery (nothing sidebar-shaped exists).

Composition stays untouched: every roster row keeps mounting, `sidebar` and
its inner seats stay declared, and plain web boots keep the unchanged
three-column shape.

## Alternatives considered

Disabling `ui-sidebar`/`ui-workspace` via a `--patch` overlay was rejected:
AppFrame always reserves a sidebar track (closed resolves to the fixed 56px
rail), so the tab would show an empty strip, and every plugin registering
into ui-sidebar-owned inner seats would fail loudly once their declaring
registration disappeared. Plumbing a config knob through the browser boot
was also rejected: the boot manifest carries no per-row config and no browser
plugin takes one, so the carrier marker is the only zero-plumbing fact both
sides already share.

## Consequences

- The editor panel reads as a pure conversation surface; the activity-bar
  sidebar becomes the only New-session button and the only session list, with
  one state source (the host broker).
- The marker check runs once per store creation inside ui-layout, with no new
  dependency edge (structural read of a pre-existing global) and no manifest,
  kernel-argument, or boot-manifest changes.
- Session management affordances inside the center column (command-menu
  entries that create sessions, empty-state starters) remain visible in
  embedded mode; they act on the same host-visible session store and are
  deliberate content, not duplicated navigation chrome.
- A future desktop client ([Electron note](../../proposed/architecture/2026-08-25-dsh-desktop-electron-shell.md))
  gets the same two-column treatment wherever it installs the transport
  marker.
