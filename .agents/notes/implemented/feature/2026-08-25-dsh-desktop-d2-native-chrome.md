# Agent Note: desktop shell D2 native chrome and kernel resilience

Status: implemented

English | [中文](2026-08-25-dsh-desktop-d2-native-chrome.zh.md)

## Problem

The D1 desktop shell (Electron main + kernel `utilityProcess` + typed
MessagePort carrier) opened a window and relayed SPA traffic, but carried no
desktop chrome — no menu, tray, notifications, or deep links — and a kernel
crash silently dropped the tunnel, leaving the window without a working
backend until the user closed it. Separately, the ESM switch of the D1 build
(scripts emit `dist/*.js` under `"type": "module"`) left `main.ts` still
referencing `kernel-entry.cjs` / `preload.cjs`, so the app could not boot at
all.

## Decision

D2 adds the native chrome and makes the kernel supervised:

- **Menu and tray.** A pure `buildAppMenuTemplate(platform)` drives
  `Menu.setApplicationMenu` (standard role menus); a best-effort `Tray` with
  a Show/Hide toggle and Quit is installed from `media/logo.svg`.
- **`dsh://` deep links.** The app registers as the default handler for the
  `dsh` scheme; `second-instance` / `open-url` focus the window and, for
  `dsh://session/<id>`, seed the SPA's persisted selection and reload. The
  URL grammar lives in a pure `parseDeepLink`.
- **Turn-end notifications.** The main process opens its own SSE stream to
  the kernel's `events.mux` endpoint on loopback and fires a `Notification`
  on every `turn/end` — independent of the renderer's own mux stream (the
  base API client reads mux/host as SSE-over-fetch, so the carrier bridges it
  into the SPA while the main process reads the same endpoint directly).
- **Kernel restart.** A `KernelSupervisor` owns the `utilityProcess`
  lifecycle: boot failures surface and stop, runtime crashes respawn the
  kernel, rewire the carrier to the new generation, and reload the window so
  the SPA reconnects. The notification stream is re-attached per generation.
- **Boot fix.** `main.ts` now references `kernel-entry.js` / `preload.js`,
  matching the ESM build outputs.

## Alternatives considered

**WebSocket for the mux stream in the main process.** Electron 33 bundles
Node 20, which has no global `WebSocket` client, so a `ws` dependency would
be required. The kernel's mux endpoint is downlink-only SSE-compatible over
fetch, which Node 20's global `fetch` reads natively — no new dependency.

**Reuse the SPA's own mux connection for notifications.** The SPA's stream
lives in the renderer and dies with each reload; a main-process stream is
independent of window reloads and kernel generations it does not outlive.

**Restart on boot failure too.** A kernel that fails to boot would restart in
a loop; boot failures surface the error and stop, while only runtime crashes
respawn.

## Consequences

- The shell is now a supervised desktop citizen: menu, tray, deep links, and
  turn-end notifications work on Windows (the CI-unverified macOS paths are
  wired and gated behind the platform checks).
- A kernel crash no longer strands the window; the SPA reconnects after the
  carrier rewires, matching the spec's generation/reconnect machine.
- The pure helpers (`menu`, `deeplink`, `notifications`) are unit-tested;
  `tests/native.spec.ts` pins the menu template, the URL grammar, and the SSE
  turn-end matcher. The supervisor itself stays Electron-bound.
- Still deferred: native file dialogs for the `host.openPath` /
  directory-picker seams (needs a host-tool bridge), the in-process kernel
  boot (needs a programmatic `dsh` boot entry), the shared host-half carrier
  package extraction, and D3 packaging.
