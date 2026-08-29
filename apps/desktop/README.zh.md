# DSH Desktop

[![非官方](https://img.shields.io/badge/DeepSeek%20Harness-非官方社区构建-f6b5c8)](https://github.com/deepseek-ai/deepseek-harness)
[![上游](https://img.shields.io/badge/上游-deepseek--ai%2Fdeepseek--harness-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md) | 中文

**DSH Desktop** 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）做成原生桌面应用——不是浏览器标签页。Node/Electron 主进程拥有原生窗口，一个 `utilityProcess` 子进程承载本地 `dsh --profile web` 内核，构建好的 web SPA 从自定义 scheme 源渲染并开启 `contextIsolation`。渲染进程完全不接触网络——其 API 流量经类型化的 `MessagePort` 载体进入主进程，再由主进程中继到内核子进程的回环 URL。

> 这是**非官方社区构建**，由 [@Shonean](https://github.com/Shonean) 维护，不由 DeepSeek 发布、背书或提供支持。「DeepSeek Harness」是 DeepSeek 的商标；本应用仅打包并配置上游开源项目。

Windows 便携版（`DSH-Desktop-<version>.exe`）在 [Releases 页面](https://github.com/Shonean/deepseek-harness-vscode-desktop/releases)发布。前置要求：PATH 上有 Node.js `^22.19 || >=24`（内核跑在系统 Node 上，而非 Electron 自带 Node），并通过应用内设置齿轮配置 DSH 凭据。

设计记录在[桌面外壳 Agent Note](../../.agents/notes/proposed/architecture/2026-08-25-dsh-desktop-electron-shell.zh.md)。

本包是 D2 里程碑：应用外壳、带自动重启的内核监管、类型化载体，以及原生 chrome——应用菜单、系统托盘、`dsh://` 深链与回合结束通知。代码连贯且有测试；Windows 便携打包已可用（D3），签名、公证与自动更新仍延后。

## 目录结构

- `src/main.ts` — Electron 主进程：特权 `dsh-assets://` 协议、内核监管、
  `MessageChannelMain` 载体接线、`BrowserWindow` 生命周期。
- `src/kernel/host.ts` — 内核监管器：拉起
  `dsh --profile web --no-open --port 0`，解析其回环 URL，经 fork 的父端口上报，
  断开时回收整棵进程树。
- `src/kernel/entry.ts` — 主进程经 `utilityProcess.fork` 运行的脚本；将
  `process.parentPort` 交给监管器类的薄封装。
- `src/carrier/protocol.ts` — 共享帧类型（`dsh.fetch`、`dsh.fetch.abort`、
  `dsh.fetch.head/chunk/end`）与收窄器，与 VSCode postMessage 载体逐字节对称。
- `src/carrier/tunnel.ts` — 宿主半侧：将一个 `MessagePortMain` 中继到内核回环
  URL，逐请求 `AbortController`，64 KiB 流式分块。
- `src/carrier/renderer-transport.ts` — 渲染半侧，由 esbuild 打包为浏览器 IIFE；
  安装 `window.__DSH_TRANSPORT__`（`createApiClient` + `fetch`），SPA 无需改动即可启动。
- `src/preload/index.ts` — contextIsolation 预加载：将唯一载体 `MessagePort`
  从主进程转发到页面主世界。
- `src/renderer/index.ts` — 纯文档构建器：CSP、载体注入、可选会话种子。
- `src/renderer/protocol.ts` — 纯自定义 scheme 辅助：源、MIME 查询、路径穿越防护。
- `src/native/menu.ts` — 纯应用菜单模板（标准角色菜单）。
- `src/native/deeplink.ts` — 纯 `dsh://` 深链解析（`dsh://session/<id>` 打开会话；裸链接聚焦窗口）。
- `src/native/notifications.ts` — 纯 SSE 帧匹配与 `watchTurnEnd`：主进程直连内核 `events.mux` 流，每个 `turn/end` 事件触发一次。
- `scripts/build.mjs` — esbuild：`dist/main.js`、`dist/preload.mjs`、
  `dist/kernel-entry.js`（ESM/node），以及 `dist/renderer-transport.js`（IIFE/浏览器）。

## 构建与运行

```sh
corepack pnpm install                         # fetches the Electron binary too
corepack pnpm --filter @deepseek-ai/dsh-desktop build
corepack pnpm --filter @deepseek-ai/dsh-desktop start
```

内核是标准的 `dsh web` 栈。CLI 与 web 前端 dist 是工作区依赖，需先构建
（在仓库根目录执行 `corepack pnpm run build`）；LLM 凭据与工具 CLI 通过 harness
自身的设置与环境配置，而非外壳。

## 内核如何启动

已批准的规格要求 `utilityProcess` 子进程承载进程内 Cordis 组合。D1 无法直接运行该形态：
`dsh` 包暴露的是 CLI bin，而非公开的编程式启动入口，而 web 服务器行正是载体所需的就绪信号。
因此 D1 宿主通过 `utilityProcess.fork` 运行 `src/kernel/entry.ts`，该监管器再以自身的
Node 孙进程拉起 `dsh --profile web --no-open --port 0`，解析
`dsh web: http://127.0.0.1:<port>` 行并经 fork 的父端口将 base URL 回报主进程。主进程随后
经载体将 SPA 的 fetch 中继到该 URL。

孙进程跑在**系统 Node.js**（`node ^22.19 || >=24`）上：harness 栈无法运行于 Electron
自带的 Node（Electron 33 是 20），因此内核 host 解析系统 node——经 pnpm 启动时用 npm 的
node、其次 `NODE` 环境变量、最后 PATH 探测——而不是 `ELECTRON_RUN_AS_NODE`。

内核仍以 Electron 外壳的子进程运行（不是隐藏渲染进程，也不是主进程的
`child_process`），其崩溃只会拆除监管器而不会拖垮窗口。D2 外壳会在内核意外退出时
重拉内核、把载体接到新一代并重载窗口，SPA 自动重连。一个延后改进是用进程内启动
web 组合（去掉 `dsh-host-webserver`）替换孙进程 CLI，并按规格把宿主半侧适配器
（`attachMessagePortTunnel` 与 VSCode 的 `attachWebTunnel`）抽取为共享包。

## MessagePort 载体如何接线

1. 内核上报 base URL 后，`main.ts` 创建一个 `MessageChannelMain`，并挂上
   `attachMessagePortTunnel(channel.port1, baseUrl)`。
2. 渲染文档加载完成后，主进程经 `webContents.postMessage('dsh-port', null,
   [port2])` 将 `channel.port2` 交给渲染进程。
3. 预加载（`contextIsolation: true`、`nodeIntegration: false`）监听
   `ipcRenderer.on('dsh-port')`，以 `dsh.renderer.port` 标记把端口重新 postMessage
   到页面主世界并转移所有权。
4. 打包的 `renderer-transport.js` IIFE（注入在 `<head>` 最前）接收端口，安装
   `window.__DSH_TRANSPORT__`，并将 SPA 的每个 fetch 经与 VSCode webview 载体相同的
   head/chunk/end 帧协议桥接。`createApiClient` 返回 `AbstractApiClient` 子类；
   `fetch` 为通用 Connection RPC 通道走同一座桥。
5. 渲染进程从特权自定义 scheme `dsh-assets://root/` 加载，该协议服务前端 dist 与载体
   IIFE。文档 CSP 仅白名单该源并设置 `connect-src 'none'`，因此即使主进程具备网络能力，
   页面也无法触达任何网络。

## D2 范围

- 一个 1280×800、带最小尺寸的 `BrowserWindow`。
- 一个内核子进程，随窗口惰性启动；关窗处置载体并杀死内核树。
- 内核监管与自动重启：内核意外退出时重拉、重接载体并重载窗口，SPA 自动重连。
- 完整 web SPA 经类型化载体从本地资源渲染。
- 原生 chrome：应用菜单、托盘切换/退出、`dsh://` 深链聚焦并打开指定会话、经内核
  `events.mux` SSE 流驱动的回合结束系统通知。
- 纯逻辑面的单元测试：协议收窄器、文档构建器、路径解析器、内核 argv/URL 解析器、
  宿主半侧载体中继、菜单模板、深链解析与回合结束 SSE 匹配。

## 打包（Windows 便携版）

`scripts/package-win.cmd` 用 `electron-builder.yml` 跑 electron-builder，写出
`release/DSH-Desktop-<version>.exe`——单个自包含便携可执行文件（关闭 asar，
以便系统 Node 内核能读取包内文件）。app id 为 `com.shonean.dsh-desktop`，
产品名为 `DSH Desktop`；构建未签名。

## 路线图

- **D3 剩余**：Windows 签名产物、自动更新脚手架、macOS 签名/公证经 CI 完成。
- **延后**：用进程内内核启动替换孙进程 CLI（需 `dsh` 提供编程式启动入口），并按
  桌面外壳规格抽取共享的宿主半侧载体包。

## 已知限制与延后工作

- 内核作为监管 `dsh` CLI bin 的 `utilityProcess` 启动，而非进程内 Cordis 树；
  无回环监听的形态需要 `dsh` 编程式启动入口，属延后改进。
- 打包后的应用仍需 PATH 上有系统 Node.js，并从包内解析内核运行时闭包；
  完全自包含的运行时负载是后续工作。
- 原生文件对话框尚未接入 SPA 的 `host.openPath` / 目录选择器缝；该能力依赖
  host 工具桥，暂延后。
- `corepack pnpm start` 之前必须先 `corepack pnpm install` 安装 `electron`。其
  postinstall 经网络下载匹配的运行时二进制，沙箱环境无法完成；类型检查与测试不需要该二进制。
- 暂无代码签名、公证或自动更新。
