# dsh VSCode integration + opencode/Claude Code subagents — design

English | [中文](2026-08-24-dsh-vscode-and-subagents-design.zh.md)

Date: 2026-08-24 · Status: approved by the user

## Goals

1. Bring dsh from the browser web UI into VSCode: a new `apps/vscode` extension providing a native sidebar chat panel.
2. Call other agents from inside: integrate **Claude Code** (existing package) and **OpenCode** (existing generic ACP provider + `opencode acp`) as subagents.
3. Pluggable main-model API: build an "API preset library" on the `dsh-llm-pi-ai` multi-provider adapters, switchable from the panel.

## Non-goals (explicitly out of v1)

- Cross-process session resumption (the SDK server creates a new session for the same name rather than resuming; changing the protocol would touch the Python SDK and is a separate project).
- Mid-run cancellation / approval flow (undefined by the wire protocol); the panel's "stop" terminates the runtime process.
- Changes to agent-loop, the existing GUI stack, or the SDK wire protocol.

## Architecture

```
VSCode 扩展 (apps/vscode)
  ├─ WebviewView 聊天 UI（本地打包资源，无外部网络）
  ├─ HarnessController：spawn 运行时子进程 + @deepseek-ai/dsh-sdk-client
  └─ ApiPresetStore：预设 CRUD + 当前预设（VSCode settings）
        │ stdio NDJSON JSON-RPC（现有协议，零改动）
        ▼
dsh 运行时子进程 = @deepseek-ai/dsh-sdk-jsonrpc-demo bin
  + apps/vscode/runtime/cordis.yml：
      dsh-sdk-jsonrpc-server / dsh-llm-pi-ai / fs-local / bash-local /
      session-persistence-jsonl / compaction / subagent 族 /
      tool-subagent(claude-code, opencode) / jobs
```

## Component contracts

### ApiPreset (extension-side data)

```ts
interface ApiPreset {
  id: string            // 稳定标识
  name: string          // 显示名
  provider: string      // ctx.llm 路由 id（如 deepseek/openai/anthropic/手写路由）
  model: string         // 该路由目录内的 model id
  apiKeyEnv?: string    // 凭证环境变量名（引用而非明文）
  baseURL?: string      // OpenAI 兼容网关覆盖
}
```

- Storage: workspace/global settings `dsh-vscode.apiPresets` + `dsh-vscode.activeApiPreset`.
- Switching = restart the runtime with the new preset's `{provider, model}` and re-run `initialize({cwd, provider, model})`.

### HarnessController (extension host)

- Lazily starts the runtime; one `initialize` per connection; forwards `session.event`/`session.status`/`subagent.*` to the webview.
- Stop button → close the client (stdin EOF→SIGTERM→SIGKILL ladder, built into the client).
- Multi-session: multiple named sessionIds coexist in one process (the server keeps one agent per sessionId); the list and titles live in extension-side state.

### Chat panel (standard-version scope)

Streaming Markdown output (assistant/chunk), collapsible tool-call rows (tool/call→tool/result states), subagent activity display (tool-row level), file-path clicks opening the editor, session list, API preset dropdown, stop button.

## Subagent configuration (pure config, zero new code)

```yaml
- id: subagent-claude-code
  name: '@deepseek-ai/dsh-subagent-claude-code'
  config: { permissionMode: dontAsk }
- id: tool-subagent-claude
  name: '@deepseek-ai/dsh-tool-subagent'
  config: { provider: claude-code, toolName: subagent_claude_code }

- id: subagent-opencode
  name: '@deepseek-ai/dsh-subagent-acp'
  config: { providerName: opencode, command: opencode, args: ['acp'], permission: allow }
- id: tool-subagent-opencode
  name: '@deepseek-ai/dsh-tool-subagent'
  config: { provider: opencode, toolName: subagent_opencode }
```

Prerequisite: the `claude` and `opencode` CLIs are installed locally (the user confirmed). Subagent models come from each tool's native configuration.

## Known limitations

1. Remote subagents emit no `subagent.finished` push (only in-process runs do); external subagent progress relies on tool-row state.
2. API keys reach the runtime process through environment variables; presets store only variable names.
3. On Windows, process-tree termination relies on the client's dispose ladder (a force-terminate branch is built in).

## Verification

- Keyless: the Loader smoke boots the real cordis.yml to validate composition; the sdk/client test infrastructure (fake-runtime) validates the controller message pipeline.
- With a key (DEEPSEEK_API_KEY): end to end — the panel sends a task, the main agent delegates to claude/opencode subagents, and the results flow back and render.
