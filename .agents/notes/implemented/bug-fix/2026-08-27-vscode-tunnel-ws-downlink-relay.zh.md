# Agent Note：隧道把内核的 WebSocket 下行流中继给 webview

Status: implemented

[English](2026-08-27-vscode-tunnel-ws-downlink-relay.md) | 中文

## 问题

面板通过仅支持 fetch 的 postMessage 隧道内嵌 SPA，但内核的两条实时事件流（`/api/events.mux`、`/api/events.host`）只以 WebSocket 形态提供：普通 GET 一律回 426，而连接插件的严格握手要求 socket 真正建立。基类 `AbstractApiClient` 对这两条流退化为 SSE，于是面板内每一代连接都撞上 426，控制器陷入重连退避循环，`onConnected` 永不触发，聊天表面始终空白——「新建会话」的点击其实创建成功了（侧栏里只看到空行），但内容永远渲染不出来。

## 决策

隧道新增单向 WebSocket 中继，沿用既有传输缝（`__DSH_TRANSPORT__.createApiClient`，其客户端 override `openMux`/`openHost`）：

- `apps/vscode/src/webview-transport.ts` —— `TunnelApiClient` 用 `bridgeDownlink` 重写两条流：发 `dsh.ws.open`，把中继回来的 `dsh.ws.frame` 文本帧排进拉取式 async generator，解析内核的 `server-request` envelope（畸形帧按浏览器 `WebApiClient` 的同一策略丢弃），喂给 `onEnvelope`，在 `dsh.ws.end`/abort 时终结。
- `apps/vscode/src/tunnel.ts` —— 宿主半侧用 Node 内置 `WebSocket`（零新依赖）应答 `dsh.ws.open`，把 open/文本/close 以 `dsh.ws.open`/`dsh.ws.frame`/`dsh.ws.end` postMessage 回传；`dsh.ws.close` 与 dispose 都会关闭 socket。

CSP 保持 `default-src 'none'`；webview 依旧不接触网络，共享的 `@deepseek-ai/dsh-client-connection` 包零改动——浏览器形态继续使用原生 WebSocket。

## 已考虑的替代方案

曾否决放宽面板 CSP、给回环地址放行 `connect-src`：那会让 webview 直接对内核开裸 socket，破坏「单一特权边界」设计以及隧道赖以存在的无网络契约。也曾否决让内核为两条路径提供 SSE 回退：426 是刻意的升级栅栏，而 fetch 可达的事件流会放宽所有部署的信任面，而不仅仅是面板。

## 后果

- 连接控制器的严格握手在面板内得以完成：两条流经隧道建立，会话事件实时渲染。
- 传输 bundle 增加约 1 KB 生成器代码；宿主半侧使用 Node 内置 WebSocket（受支持 Node 版本范围内可用）。
- 未来任何无法开 WebSocket 的载体都可复用同一条缝：在其客户端上 override `openMux`/`openHost` 并提供帧即可。
