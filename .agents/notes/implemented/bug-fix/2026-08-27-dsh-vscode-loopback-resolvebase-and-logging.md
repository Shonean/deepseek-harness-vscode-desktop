# Agent Note: dsh-vscode loopback client targeted the dsh.internal fake authority, and the host had no logs

Status: implemented

English | [中文](2026-08-27-dsh-vscode-loopback-resolvebase-and-logging.zh.md)

## Problem

After the kernel runtime fix, `dsh.openChat`/`dsh.newSession` still failed with a bare `fetch failed` in the real host. `AbstractApiClient.resolveBase()` returns `globalThis.location.origin` in a browser and the `dsh.internal` fake authority otherwise — a base designed for in-process handler injection, never real DNS. `LoopbackApiClient` overrode only `doFetch`, so in the extension host every broker call resolved `http://dsh.internal/api/...`, left the machine through DNS, and died on the sandbox's fake-IP resolver. The webview-side `TunnelApiClient` survived only because `bridgeFetch` consumes just the path. No output channel existed, so the real window offered no way to see which request failed or why the kernel child died.

## Decision

Both tunnel clients now override `resolveBase()`: the loopback client returns its kernel base URL, and the webview client pins the fake authority with a comment stating that `bridgeFetch` consumes only path plus query. A new `log.ts` binds one "DeepSeek Harness" output channel at activation and every layer logs through it — spawn command/cwd/bin, kernel stdout/stderr lines, exit code with stderr tail, broker readiness, per-request tunnel method/path/status/duration, and command entries; `dsh.showLogs` reveals the channel. Webview-side failures surface in the same channel: the panel transport and the sidebar script both report `window.onerror`/`unhandledrejection` to the host, which logs them. With no workspace folder open, the kernel cwd falls back to the home directory — the extension host's `process.cwd()` is the VSCode install directory, and agent sessions must never target it. The editor tab uses pink light/dark PNGs because `WebviewPanel.iconPath` ignores SVG. A keyless host-simulation suite (`apps/vscode/tests/host-sim.spec.ts`) loads the built bundle with a stubbed `vscode` module, activates it, runs the real `dsh.newSession` handler against a genuine kernel child, relays one tunnel fetch end-to-end, and asserts the log lines; `DSH_HOST_SIM_EXT` repoints it at an installed extension directory.

## Alternatives considered

**Fix only the loopback client.** The webview client currently works by the accident of `bridgeFetch` ignoring the origin; pinning `resolveBase` in both subclasses turns that accident into the stated contract.

**Log to a file under the extension log directory.** The output channel already survives in VSCode's log folder and is one click away (`dsh.showLogs`); a second sink would split the evidence without adding reachability.

## Consequences

A broker call can no longer leave the machine: the loopback base is the kernel port, and the webview path never carries an origin. Host-side failures now produce a readable transcript — kernel spawn line, stdout/stderr, exit code, and the exact failing tunnel request — instead of a bare `fetch failed`. The host-simulation suite closes the gap that let both earlier regressions reach the real window: it exercises the bundle the user runs, not only the source helpers.
