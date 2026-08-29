# Agent Note: Embedded carriers reach settings through a shell.overlay entry

Status: implemented

English | [中文](2026-08-28-embedded-settings-overlay-entry.zh.md)

## Problem

The embedded-carrier layout ([carrier-mode note](2026-08-27-vscode-embedded-layout-carrier-mode.md)) hides the SPA's sidebar column in the VSCode panel and desktop shell, because the native host owns session navigation. `ui-settings-general` registered its whole settings shell into `sidebar.settings` — the gear trigger, the modal panel, and the API-key onboarding all hung off that one seat. With the sidebar column unrendered in carrier mode, the gear never mounted, so the settings modal and credential onboarding became unreachable: a first-run user in VSCode could not configure an API key anywhere in the panel.

## Decision

The settings plugin keeps one shell and picks its occupant seat at composition time. `apply` in `packages/client/ui-settings-general/src/client/index.ts` reads the carrier marker once (a local `hasTransportCarrier()` mirroring ui-layout's read of `window.__DSH_TRANSPORT__`; cross-plugin value imports are forbidden for client packages):

- plain browser: unchanged — the shell registers into `sidebar.settings`;
- embedded carrier: a thin `OverlaySettingsEntry` registers into ui-layout's root-scope list slot `shell.overlay`, anchoring a floating rail gear at the frame's top-right and mounting the same `SettingsRoot` with `wide: false` (rail glyph, no label).

The occupant declares the identical six settings child seats (`settings.trigger/header/action/close/section/onboarding`) in both branches; exactly one seat is taken per carrier, so the declarations never collide. The settings modal panel and onboarding already render as fixed full-viewport layers, so they mount and behave identically from either seat.

AppFrame exposes the details-panel width as the frame custom property `--dsh-details-w`; the floating anchor offsets from the details edge (`right: calc(var(--dsh-details-w) + 12px)`) so the gear never paints over an open details panel.

## Alternatives considered

- Re-rendering the sidebar column in a collapsed rail just for the gear was rejected: it resurrects the 56px empty track the carrier mode removed and reintroduces a second navigation-shaped surface in a host that owns navigation.
- A host-side VSCode command opening a native settings page was rejected: the settings content (sections, onboarding steps, credential flows) is entirely client-plugin composed; duplicating it host-side forks the surface.
- Importing ui-layout's `hasTransportCarrier` was rejected by the cross-package value-import rule; the marker is a stable, documented global, so a local three-line structural read is the sanctioned route.

## Consequences

- Settings, API-key onboarding, and every `settings.action` row are reachable in the VSCode panel and desktop shell via the top-right gear; browser deployments are byte-for-byte unchanged (the overlay branch never runs without the marker).
- The gear rides a frame-level overlay rather than a conversation-region element, so it stays visible across sessions and detail states; its z-index and pointer-events opt-in are scoped to the anchor alone (the overlay layer stays click-through).
- Future embedded carriers get the entry for free by installing the transport marker — no per-host settings wiring.
- Verification: `ui-settings-general` + `ui-layout` unit suites (114 tests, including carrier-branch registration and HMR teardown assertions), full `test:gui`, app tsc and oxlint green. The browser assembled surface is unchanged, so no web snapshot output changed; `test:web` replay was not rerun on this Windows checkout (the slow dist rebuild plus the documented Windows-platform fixture failures).
