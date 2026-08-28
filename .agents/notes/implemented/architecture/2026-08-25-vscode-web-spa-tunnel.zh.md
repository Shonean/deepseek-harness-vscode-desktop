# Agent Note：VSCode 扩展通过 postMessage 隧道承载网页 SPA

Status: implemented

[English](2026-08-25-vscode-web-spa-tunnel.md) | 中文

## 问题

VSCode 扩展过去用手写 webview 渲染聊天：自有消息协议、DOM 对话记录、预设下拉框，以及一个独立于网页产品的 stdio JSON-RPC 子进程（`@deepseek-ai/dsh-sdk-client`）。网页 SPA 新增的每个功能（工作区、子代理、附件、主题）都要重新实现或直接缺失，两个界面持续漂移。目标是在 VSCode 内使用唯一的聊天实现——真实的网页 SPA——并配一个复刻 Claude Code 布局的精简侧边栏。

## 决策

扩展启动与 CLI 所服务的同一个网页宿主——`dsh --profile web --no-open --port 0`，绑定到 `127.0.0.1` 的随机端口——作为子进程（`kernel.ts`），并把 SPA 的构建产物 `dist` 装入编辑区的 `WebviewPanel`。webview 自身不接触网络：

- 宿主半侧（`tunnel.ts`）用 `fetch` 把 `dsh.fetch` / `dsh.fetch.abort` postMessage 中继到回环地址，并把响应体以 base64 的 `dsh.fetch.head/chunk/end` 帧流式回传。
- 浏览器半侧（`webview-transport.ts`，打包为 IIFE）继承 `AbstractApiClient`，在 SPA 启动前安装 `window.__DSH_TRANSPORT__`，使 SPA 的连接插件经隧道而非 HTTP+WS 通信。
- `webview-index.ts` 把内核渲染的 index 中根相对资源 URL 改写为 webview 资源 URI，并注入 CSP 与传输脚本。

唯一的 `KernelBroker` 为两个界面持有同一个内核，并暴露一个回环 `AbstractApiClient` 供侧边栏列出/创建会话。活动栏侧边栏（`sidebar-view.ts`）刻意精简：一个新建会话按钮与会话列表。选中某行即在完整面板中打开该会话。SPA 没有宿主到 SPA 的运行时导航接缝，因此导航通过预置其持久化选择（`localStorage['dsh.sessions.current']`）并重载文档实现；SPA 在启动时恢复该会话。

旧的手写聊天（`chat-view.ts`、`harness-controller.ts`、`preset-store.ts`、`runtime-resolver.ts`、捆绑的 `runtime/cordis.yml` 及其测试）被彻底删除，而非保留兼容垫片。凭据、模型与工具配置移交给 harness 自身的设置；扩展只设置语言。

## 后果

- VSCode 面板即网页 SPA，因此无需二次实现即可继承未来的网页功能。扩展的运行时表面收敛为进程持有与请求中继。
- webview 的 CSP 拒绝直接网络访问；所有流量经过扩展宿主，后者是唯一的特权边界。内核只监听回环地址。
- 会话导航是带 localStorage 预置的重载，而非就地路由。未来的宿主到 SPA 导航接缝（一条客户端运行时转为 `ctx.sessions.open` 的消息）可让我们去掉重载；在此之前，预置是受支持的契约，SPA 自身的校验会防护过期 id。
- 会话列表新鲜度依赖宿主轮询（2 秒）`session.list`，而非 SPA 的事件流；侧边栏不打开 mux/host SSE 流。
- 包的运行时依赖收敛为 `@deepseek-ai/dsh`（内核 CLI）与 `@deepseek-ai/dsh-web-frontend`（静态 dist）；SDK 客户端与 demo 组合不再是依赖。

## 考虑过的替代方案

- **保留手写聊天并补齐功能至对等**——否决：它重复网页产品，必然长期漂移；网页 SPA 才是被维护的界面。
- **用指向回环 URL 的 iframe 承载 SPA**——否决：跨源 frame 的 webview CSP、webview 直接网络访问以及主题/凭据隔离都会变差，且放弃了 SPA 已为备用传输定义的 `__DSH_TRANSPORT__` 接缝。
- **在同一改动中给客户端加 postMessage 导航接缝**——推迟：localStorage 预置今天就能对已发布的 SPA 生效，无需改动客户端包；重载代价对 v1 可接受，该接缝是干净的后续工作。
