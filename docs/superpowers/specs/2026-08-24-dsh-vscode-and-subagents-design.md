# dsh VSCode 集成 + opencode/Claude Code 子代理 — 设计

日期：2026-08-24 · 状态：已获用户批准

## 目标

1. 把 dsh 从"浏览器 Web UI"形态接入 VSCode：新增 `apps/vscode` 扩展，提供原生侧边栏聊天面板。
2. 内置调用其它 agent 的能力：以子代理形式接入 **Claude Code**（现成包）与 **OpenCode**（现成通用 ACP 提供者 + `opencode acp`）。
3. 主模型 API 可插拔：基于 `dsh-llm-pi-ai` 多 provider 适配器建立「API 预设库」，面板可随意切换。

## 非目标（v1 明确不做）

- 跨进程会话续聊（SDK 服务端对同名 session 是新建而非 resume；改协议连带 Python SDK，单独立项）。
- 中途取消 / 审批流（wire 协议未定义）；面板"停止"= 终止运行时进程。
- 修改 agent-loop、GUI 现有栈或 SDK wire 协议。

## 架构

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

## 组件契约

### ApiPreset（扩展侧数据）

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

- 存储：workspace/global settings `dsh-vscode.apiPresets` + `dsh-vscode.activeApiPreset`。
- 切换 = 以新 preset 的 `{provider, model}` 重启运行时并重新 `initialize({cwd, provider, model})`。

### HarnessController（扩展宿主）

- 懒启动运行时；`initialize` 一次连接一次；订阅 `session.event`/`session.status`/`subagent.*` 转发给 webview。
- 停止按钮 → 关闭 client（stdin EOF→SIGTERM→SIGKILL 阶梯，client 自带）。
- 多会话：同一进程内多个命名 sessionId 并存（服务端每 sessionId 一个 agent）；列表与标题存扩展侧 state。

### 聊天面板（标准版范围）

流式 Markdown 输出（assistant/chunk）、工具调用折叠行（tool/call→tool/result 状态）、子代理活动展示（工具行级）、文件路径点击跳转编辑器、会话列表、API 预设下拉、停止按钮。

## 子代理配置（纯配置，零新代码）

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

前置条件：本机已安装 `claude` 与 `opencode` CLI（用户确认已装）。子代理模型由各自原生配置决定。

## 已知限制

1. 远程子代理无 `subagent.finished` 推送（仅本进程 run），外部子代理进度靠工具行状态。
2. API key 经环境变量注入运行时进程；预设只存变量名。
3. Windows 下进程树终止依赖 client 的 dispose 阶梯（已内建 force-terminate 分支）。

## 验证

- keyless：Loader smoke 启动真实 cordis.yml 验证组合合法；sdk/client 测试基建（fake-runtime）验证控制器消息管线。
- 有 key（DEEPSEEK_API_KEY）：端到端——面板发任务 → 主代理派活 claude/opencode 子代理 → 结果回流渲染。
