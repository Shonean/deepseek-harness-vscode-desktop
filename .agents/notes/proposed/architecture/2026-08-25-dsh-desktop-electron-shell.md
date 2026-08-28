# Agent Note: dsh desktop shell on Electron with a local kernel child process

Status: proposed

English | [中文](2026-08-25-dsh-desktop-electron-shell.zh.md)

## Problem

dsh ships CLI, headless, ACP, browser Web, and VSCode surfaces but no desktop application. The product requirement is to match the Claude Code / Codex desktop form factor — a native-feeling desktop app that owns a local agent kernel — while explicitly forbidding a wrapped-website shell (loading a remote or hosted web page in a desktop chrome). The web GUI is already a mature React SPA with a designed carrier seam, so the desktop decision is mostly about shell technology, process model, and how the kernel connects.

## Proposal

Build the desktop app on **Electron**, Windows-first, with this topology:

- **Main process** (Node): native chrome — application menu, tray, notifications, global shortcut, `dsh://` deep link, auto-update scaffolding, native file dialogs. It spawns the kernel and routes one MessagePort pair per renderer.
- **Kernel child** (`utilityProcess`): a Node child process hosting the in-process Cordis composition — the `dsh --profile web` assembly minus `dsh-host-webserver`: API gateway, runtime, sandboxed tool providers, persistence. A kernel crash never takes the window down; the main process restarts it and the SPA reconnects over the existing generation/reconnect machine.
- **Renderer**: the built web SPA loaded over `file://` from the bundled dist, `contextIsolation` on, a typed preload bridge exposing the `__DSH_TRANSPORT__` hooks (`createApiClient`, `fetch`, `loadBundle`). The SPA renders every web feature unchanged, with Chinese product copy.

The wrapped-website ban is satisfied architecturally, not cosmetically: the kernel is local and owned, the UI loads local files, the IPC bridge is typed, offline works, and tool execution rides the per-OS sandbox providers the repo already ships (`native/landlock-run`, `sandbox-local`, `sandbox-windows-acl`). Native opening (`host.openPath`) and the native directory picker route through the Electron dialog/shell APIs, the providers the directory-picker seam note anticipated.

The carrier host-half adapter — transport frames in, `FetchHandler.fetch` out — is extracted into a shared package consumed by both the VSCode extension (postMessage carrier) and the desktop (MessagePort carrier), per the VSCode A2 decision.

## Alternatives considered

**Tauri (Rust shell + system WebView).** Smaller footprint and lower memory, but the kernel remains Node, so a Tauri app carries two runtimes and a second IPC serialization; the three platform WebViews (WebView2/WebKitGTK/WKWebView) threaten the SPA's CSS assumptions; the team is TypeScript-first. Rejected.

**Native Swift/Kotlin app.** The strongest platform feel and what Codex's desktop app reportedly uses (unverified from this sandbox — external research was network-blocked; the Claude Desktop Electron precedent anchors the comparison regardless). A native UI rewrites the mature web GUI across three platforms at triple the cost. Rejected.

**Loopback server inside the shell (the VSCode A1 shape).** The kernel child binds `127.0.0.1` and the renderer loads it over HTTP. It works with zero client changes but opens a network listener a desktop app does not need, and the served-carrier trust fence (loopback pinning) exists precisely because the browser carrier cannot be narrowed further. The IPC bridge is strictly less exposed. Rejected for the desktop.

**Wrapping the hosted web app.** Explicitly forbidden by the product requirement and architecturally worse: it needs a deployed server, breaks offline, and owns no kernel.

## Acceptance criteria

- Windows package installs and launches; the SPA renders every web feature from local files with no network listener.
- Kernel runs as a child process; killing it shows a reconnecting state and the shell recovers it without losing the window.
- Native menu, tray presence, and a turn-end notification work on Windows.
- `dsh://` deep link focuses the app and opens the referenced session.
- Tool execution composes the per-OS sandbox providers; `host.openPath` opens files through the shell.
- electron-builder produces a signed-or-unsigned Windows artifact; macOS signing/notarization stays a CI-owned follow-up (not verifiable on this machine).

## Risks

- Electron's memory footprint matches Claude Desktop's class of app; accepted as the form-factor cost.
- The in-process composition inside `utilityProcess` concentrates lifecycle complexity — startup ordering, disposal, restart — and needs the repo's defensive-patterns review.
- macOS code signing and notarization cannot be validated on this machine; the first macOS artifact lands through CI with that caveat.
- Codex-desktop form-factor details remain unverified until external research is possible; they do not affect the shell choice, which the Claude Desktop precedent anchors.
