# Agent Note: dsh VSCode sidebar extension over the JSON-RPC runtime

Status: implemented

English | [中文](2026-08-24-dsh-vscode-sidebar-extension.zh.md)

## Problem

dsh shipped CLI, headless, ACP, and browser Web surfaces but no editor integration, so work inside VSCode meant leaving the editor or driving raw JSON-RPC by hand. Two adjacent gaps compounded it: delegating subtasks to other agent CLIs (Claude Code, OpenCode) required hand-built tooling per CLI, and OpenAI-compatible gateways had no switchable route story outside config edits.

## Decision

`apps/vscode` (`@deepseek-ai/dsh-vscode`) is a release-member VSCode extension providing a native sidebar chat panel. Its host process owns one dsh runtime subprocess — the `@deepseek-ai/dsh-jsonrpc-agent` bin launched with the bundled `runtime/cordis.yml` — and speaks the existing stdio NDJSON JSON-RPC protocol through `@deepseek-ai/dsh-sdk-client`. The wire protocol, agent loop, and SDK server stay untouched; the extension is a consumer of frozen seams, and every panel capability (streaming text, tool call rows, subagent activity lines, file-path links, session list) renders from notifications that already exist on the wire.

### Composition and subagents as configuration

`runtime/cordis.yml` mounts the JSON-RPC server, file settings and local credentials, DeepSeek plus pi-ai multi-provider LLM routes, bash/fs tools over local providers, JSONL session persistence with checkpoint policy and projection, token meter, compaction, todo, and the subagent family. Claude Code (`@deepseek-ai/dsh-subagent-claude-code`) and OpenCode (`@deepseek-ai/dsh-subagent-acp`) mount as plain config rows; two `@deepseek-ai/dsh-tool-subagent` instances expose them as `subagent_claude_code` and `subagent_opencode`. Delegation ships as configuration only — no new delegation code lives in the app.

### API presets share ainovel's preset library

`ApiPresetStore` treats `~/.claude/ainovel-write/api_library.json` as the single source of truth for API routes: `text_presets[].fields` under the `ARK_API_KEY` / `ARK_BASE_URL` / `ARK_MODEL_PRO` keys map 1:1 to extension presets, and `current_text_id` is the active selection shared with ainovel itself. The panel dropdown, quick pick, and add-preset flow read/write this file through the store. When the runtime starts, the active preset's values become environment variables on the subprocess (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, plus the `ARK_*` mirrors); switching to a preset with a different model or base URL tears the subprocess down so the next prompt re-runs `initialize` carrying the new route. Preset switching never touches provider routing code — routes resolve through pi-ai's catalog and the OpenAI-compatible route key.

### Stop semantics and lifecycle

The panel has no mid-turn cancel: stop closes the SDK client, which runs its stdin EOF → SIGTERM → SIGKILL escalation against the process tree. Multiple named sessions multiplex over one runtime subprocess, created lazily on the first prompt; titles derive from the session's first user message.

## Alternatives considered

**Store presets in `dsh-vscode.apiPresets` settings with credential variable names.** Settings integration is idiomatic VSCode and avoids plaintext keys in a foreign file, but it forks the user's existing manual editing surface into a second library that must be kept in sync. Sharing ainovel's file keeps one library and one selection; the accepted cost is that the extension inherits ainovel's schema and its plaintext-key contract instead of defining a stricter one.

**A cancel RPC for mid-turn stop.** Keeping the turn cancellable from the panel without killing the runtime preserves sibling sessions and startup cost, but the wire protocol has no cancel vocabulary, and adding one cascades into server semantics and both SDK clients. Process termination reuses the client's tested dispose ladder; sibling sessions in the same subprocess die with it, which the panel accepts as stop's meaning.

**Running the runtime composition in-process inside the extension host.** In-process mounting removes subprocess management entirely, but stdout framing belongs to the SDK server, Cordis disposal would couple to extension-host teardown timing, and a crashing runtime takes the editor process down with it. The subprocess line keeps crash isolation and lets the resolver fall back to a user-configured command.

**Rendering assistant output as Markdown via an external renderer bundle.** Richer typography was traded away deliberately: the webview CSP forbids external resources, and a self-contained script keeps the review surface and supply chain minimal while tool rows and path linkification carry the structure users need.

## Verification

Keyless package tests drive `HarnessController` through a fake harness: lazy start on first prompt, restart when the active preset changes model or base URL, rejection before any preset is selected, and stop terminating the runtime. A smoke spec boots the real bundled `cordis.yml` under tsx, initializes over stdio, prompts against a local stub model server, asserts both delegation tools appear in the request payload, and shuts down cleanly with exit code 0. An OpenRouter e2e completes one real turn through the same bundled composition using opencode's logged-in key, self-skipping without one. Typecheck, lint, knip, and workspace constraints cover the package surface; real-API end-to-end requires `DEEPSEEK_API_KEY` plus locally installed `claude` and `opencode` binaries.

## Consequences

Credentials live in ainovel's plaintext file in the user home; that file predates the extension and remains its contract, so nothing new stores secrets but the extension can read them. External subagents emit no `subagent.finished` notification, so their progress shows only through the owning tool row's state. Cross-process session resume stays out of scope — the SDK server creates rather than resumes same-named sessions — so closing VSCode abandons in-flight turns and history replays only through the persisted JSONL logs, not the panel. Publishing follows the repository's npm release-member policy (public access, no source maps, `dist` + `runtime` + `media` payload), and the installable VSIX packs from that same tarball ([VSIX packaging](../process/2026-08-25-dsh-vscode-vsix-from-publish-tarball.md)). On Windows, process-tree termination rides the client's escalation ladder, which unit fakes exercise only indirectly.
