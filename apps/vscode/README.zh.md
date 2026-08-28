# @deepseek-ai/dsh-vscode

[English](README.md) | 中文

在 VSCode 内使用 DeepSeek Harness：活动栏里一个精简的会话侧边栏，编辑区里一个完整的网页聊天面板。扩展把本地 `dsh web` 内核作为子进程启动，绑定到 `127.0.0.1` 的随机端口，再把真实网页 SPA 装入 webview。webview 自身不接触网络——扩展宿主通过 postMessage 隧道把每个请求中继到回环地址，因此没有 CORS 暴露面，内核保持单源。

活动栏侧边栏是唯一的会话表面：它的新建会话按钮与会话列表驱动面板，而内嵌 SPA 会隐藏自己的侧栏列（ui-layout 的载体模式响应本扩展安装的 `window.__DSH_TRANSPORT__` 标记），VSCode 里始终只有一个「新建会话」入口和一份会话列表。

## 目录结构

- `src/extension.ts` — 激活、命令注册与 broker 装配。
- `src/kernel-broker.ts` — 持有唯一的共享内核子进程与一个回环 API 客户端；列出、创建会话并轮询变化。
- `src/kernel.ts` — 启动 `dsh --profile web --no-open --port 0`，解析其回环 URL，销毁时回收进程树。
- `src/tunnel.ts` — 面板隧道的宿主半侧：把 webview 的 fetch 中继到内核，把响应体以 postMessage 帧流式回传；为每条内核下行通道（`/api/events.mux`、`/api/events.host`）持有一条宿主 WebSocket 并回传其文本帧，使 SPA 的实时会话事件在 webview 无网络 CSP 下仍能到达面板。
- `src/webview-transport.ts` — 浏览器半侧，打包为 `dist/webview-transport.js`；安装 `window.__DSH_TRANSPORT__`，使 SPA 经隧道启动。
- `src/web-panel.ts` — 编辑区的 `WebviewPanel`，承载 SPA，通过 SPA 的持久化选择预置到目标会话。
- `src/sidebar-view.ts` — 精简侧边栏：新建会话按钮与会话列表；选中某行即在完整面板中打开该会话。
- `src/webview-index.ts` — 纯函数的 index 改写：根相对资源 URL 转 webview URI、CSP、传输/预置脚本注入，以及主题桥接脚本。

## 构建

```sh
pnpm --filter @deepseek-ai/dsh-vscode run build
```

esbuild 产出两个包：`dist/extension.cjs`（CJS，`vscode` 外置）与 `dist/webview-transport.js`（浏览器 IIFE）。它启动的内核 CLI 与所服务的网页前端 dist 是工作区依赖，必须先构建（在仓库根目录执行 `pnpm run build`）。

## 打包 VSIX

```sh
pnpm --filter @deepseek-ai/dsh-vscode run pack:vsix
```

写出 `dist/dsh-vscode-<version>.vsix`，从发布 tarball（`pnpm pack`）派生：VSIX 携带的内容与已发布的 npm 包完全一致。同版本重新打包会替换上一次输出。

## 设置

- `dsh-vscode.uiLocale` — 侧边栏与面板界面语言：`auto` 跟随 VSCode 显示语言，`en` 英文，`zh-cn` 简体中文。修改后侧边栏自动重载。

## 主题

面板跟随 VSCode 当前配色主题。SPA 通过 `matchMedia('(prefers-color-scheme: dark)')` 解析 `system` 偏好，因此扩展注入一段桥接脚本，改由 VSCode 主题类型回答配色查询；活动主题变化时，再经 `dsh.vscodeTheme` 消息推送实时更新。

## 命令

- `DeepSeek Harness: Open DeepSeek Harness`（`dsh.openChat`）— 打开完整面板。
- `DeepSeek Harness: New DeepSeek Harness Session`（`dsh.newSession`）— 创建会话并在面板中打开。
- `DeepSeek Harness: Close DeepSeek Harness`（`dsh.closeChat`）— 关闭面板（共享内核继续为侧边栏运行）。

## 要求

内核即标准的 `dsh web` 栈；LLM 凭据与工具 CLI 通过 harness 自身的设置与环境配置，而非本扩展。
