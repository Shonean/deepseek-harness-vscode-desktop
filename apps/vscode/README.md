# @deepseek-ai/dsh-vscode

Native VSCode sidebar chat for the DeepSeek Harness runtime. The extension
spawns the dsh JSON-RPC runtime as a child process, communicates over stdio
NDJSON JSON-RPC through `@deepseek-ai/dsh-sdk-client`, and renders streaming
output, tool calls, and subagent activity in a webview panel.

## Layout

- `src/extension.ts` — activation, command registration, and wiring.
- `src/harness-controller.ts` — owns one runtime subprocess and routes its
  notifications to named chat sessions; switching API preset restarts it.
- `src/preset-store.ts` — CRUD over the ainovel preset library at
  `~/.claude/ainovel-write/api_library.json` (`text_presets[].fields` with the
  `ARK_API_KEY` / `ARK_BASE_URL` / `ARK_MODEL_PRO` keys, `current_text_id` as
  the active selection). Preset values are injected as environment variables
  into the runtime process; the store itself never resolves them.
- `src/chat-view.ts` — self-contained webview (no external network) with the
  chat transcript, session switcher, preset dropdown, and stop button.
- `src/runtime-resolver.ts` — locates the `dsh-jsonrpc-agent` bin and the
  bundled `runtime/cordis.yml`.
- `runtime/cordis.yml` — the composition loaded into the runtime: JSON-RPC
  server, DeepSeek + pi-ai multi-provider LLM, bash/fs tools, persistence,
  compaction, and Claude Code / OpenCode subagent tools.

## Building

```sh
pnpm --filter @deepseek-ai/dsh-vscode run build
```

This bundles `src/extension.ts` to `dist/extension.cjs` with esbuild. The
runtime packages it spawns must be built first (`pnpm run build:lib:host`).

## Requirements

The bundled composition mounts `@deepseek-ai/dsh-subagent-claude-code` and
`@deepseek-ai/dsh-subagent-acp` (OpenCode). Their native CLIs (`claude` and
`opencode`) must be on `PATH` for the corresponding delegation tools to run.
