# DSH for VS Code

[![非官方](https://img.shields.io/badge/DeepSeek%20Harness-非官方社区构建-f6b5c8)](https://github.com/deepseek-ai/deepseek-harness)
[![上游](https://img.shields.io/badge/上游-deepseek--ai%2Fdeepseek--harness-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md) | 中文

**DSH for VS Code** 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）——基于插件、完全本地运行的 AI 编码 agent——搬进 VS Code：活动栏里一个精简的会话侧边栏，编辑区里完整的 DSH 网页聊天面板。

> 这是**非官方社区构建**，由 [@Shonean](https://github.com/Shonean) 维护，不由 DeepSeek 发布、背书或提供支持。「DeepSeek Harness」是 DeepSeek 的商标；本扩展仅打包并配置上游开源项目。

## 功能

- 活动栏侧边栏列出 DSH 会话，并提供唯一的**新建会话**按钮；选中会话即在编辑器标签页打开完整的 DSH 网页 SPA。
- 扩展把本地 `dsh web` 内核作为子进程启动，绑定 `127.0.0.1` 随机端口。webview 自身不接触网络——扩展宿主通过 postMessage 隧道把每个请求中继到回环地址，没有 CORS 暴露面，内核保持单源。
- 内嵌 SPA 会隐藏自己的侧栏列（它检测 `window.__DSH_TRANSPORT__` 载体标记），VS Code 里始终只有一份会话列表、一个新建会话入口。
- 面板跟随 VS Code 当前配色主题，包括切换主题时的实时更新。
- 面板右上角有悬浮设置齿轮，可打开 DSH 的设置模态与 API Key onboarding——没有 SPA 自有侧栏时这些入口原本不可达。

## 前置要求

- PATH 上有 Node.js `^22.19 || >=24`（内核跑在系统 Node 上，而非 VS Code 内置 Node）。
- LLM 凭据（如 `DEEPSEEK_API_KEY`）和工具 CLI 通过 DSH 自己的设置面板或环境配置——首次启动会话后点面板里的齿轮即可。无需单独安装 DeepSeek Harness：VSIX 自带自包含内核运行时（`dsh` CLI、全部 web profile 插件与所服务的网页前端），干净机器上扩展旁不需要任何 `node_modules`。

## 安装

1. 从 [Releases](https://github.com/Shonean/deepseek-harness-vscode-desktop/releases) 下载最新 `.vsix`。
2. VS Code 中：扩展视图 → `…` 菜单 → **从 VSIX 安装…**，或：

   ```sh
   code --install-extension dsh-vscode-0.1.0.vsix
   ```

3. 打开活动栏的 **DSH** 容器，点击**新建会话**。首次启动会拉起本地内核（数秒），随后面板显示 DSH 聊天界面。

## 命令

- `DSH: Open DSH Panel`（`dsh.openChat`）— 打开完整面板。
- `DSH: New DSH Session`（`dsh.newSession`）— 创建会话并在面板中打开。
- `DSH: Close DSH Panel`（`dsh.closeChat`）— 关闭面板（共享内核继续为侧边栏运行）。
- `DSH: Show DSH Logs`（`dsh.showLogs`）— 打开扩展输出通道。

## 设置

- `dsh-vscode.uiLocale` — 侧边栏与面板界面语言：`auto` 跟随 VS Code 显示语言，`en` 英文，`zh-cn` 简体中文。修改后侧边栏自动重载。

## 已知限制

- VSIX 以 hoisted 生产闭包（pnpm deploy）携带内核运行时，因此体积较大（压缩后数十 MB、数万个文件），从扩展视图安装偏慢——首次安装请耐心等待。
- 尚未配置签名的 macOS/Windows 构建与市场发布；目前仅支持 VSIX 安装。

## 开发

宿主侧代码结构：

- `src/extension.ts` — 激活、命令注册与 broker 装配。
- `src/kernel-broker.ts` — 持有唯一的共享内核子进程与一个回环 API 客户端；列出、创建会话并轮询变化。
- `src/kernel.ts` — 启动 `dsh --profile web --no-open --port 0`，解析其回环 URL，销毁时回收进程树。
- `src/tunnel.ts` — 面板隧道的宿主半侧：把 webview 的 fetch 中继到内核，把响应体以 postMessage 帧流式回传；为每条内核下行通道（`/api/events.mux`、`/api/events.host`）持有一条宿主 WebSocket 并回传其文本帧。
- `src/webview-transport.ts` — 浏览器半侧，打包为 `dist/webview-transport.js`；安装 `window.__DSH_TRANSPORT__`，使 SPA 经隧道启动。
- `src/web-panel.ts` — 编辑区承载 SPA 的 `WebviewPanel`。
- `src/sidebar-view.ts` — 精简侧边栏：新建会话按钮与会话列表。
- `src/webview-index.ts` — 纯函数的 index 改写：根相对资源 URL 转 webview URI、CSP、传输/预置脚本注入与主题桥接脚本。

```sh
pnpm --filter @deepseek-ai/dsh-vscode run build      # esbuild: dist/extension.cjs + dist/webview-transport.js
pnpm --filter @deepseek-ai/dsh-vscode run runtime    # materialize runtime/: the pnpm-deploy kernel closure (prod-only, pruned)
pnpm --filter @deepseek-ai/dsh-vscode run pack:vsix  # build + runtime closure + dist/dsh-vscode-<version>.vsix from the publish tarball
```

`pack:vsix` 先打发布 tarball（`files` 字段含 `runtime/node_modules/**`）再装进 VSIX 布局。闭包内容由仅声明依赖的工作区包 `apps/vscode/runtime-deploy`（`dsh-web-runtime-closure`）一次性定义：其依赖表即 web 内核——`dsh` CLI、所服务的前端、web profile 与自带 preset 按裸包名加载的全部插件，以及 Cordis 必需的非可选工作区 peer。新增分发插件只需在那里加一行依赖。源码检出下没有 `runtime/` 时，扩展回退到从旁边的工作区 `node_modules` 解析（[runtime-resolution.ts](src/runtime-resolution.ts)）。

内核 CLI 与所服务的网页前端 dist 是工作区依赖，需先在仓库根目录执行 `pnpm run build`。

## 许可证

MIT，与上游 DeepSeek Harness 一致。
