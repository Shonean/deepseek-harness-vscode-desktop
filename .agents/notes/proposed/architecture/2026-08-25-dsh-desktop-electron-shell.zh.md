# Agent Note: dsh desktop shell on Electron with a local kernel child process

Status: proposed

[English](2026-08-25-dsh-desktop-electron-shell.md) | 中文

## 问题

dsh 已有 CLI、headless、ACP、浏览器 Web 与 VSCode 形态，但没有桌面应用。产品要求对齐 Claude Code / Codex 的桌面形态——一个拥有本地 agent 内核、原生质感的桌面应用——同时明确禁止套壳（在桌面外壳里加载远程或托管的网页）。web GUI 已是成熟 React SPA 且带有设计好的载体缝，因此桌面端的决策主要集中在壳技术、进程模型与内核连接方式。

## 提案

桌面应用构建在 **Electron** 上，Windows 优先，拓扑如下：

- **Main 进程**（Node）：原生 chrome——应用菜单、托盘、通知、全局快捷键、`dsh://` 深度链接、自动更新脚手架、原生文件对话框。它拉起内核，并为每个 renderer 路由一对 MessagePort。
- **内核子进程**（`utilityProcess`）：承载进程内 Cordis 组合的 Node 子进程——即去掉 `dsh-host-webserver` 的 `dsh --profile web` 组合：API gateway、runtime、沙箱化工具提供方、持久化。内核崩溃不会拖垮窗口；主进程重启它，SPA 经既有的 generation/重连机制自动恢复。
- **Renderer**：从捆绑 dist 经 `file://` 加载构建好的 web SPA，`contextIsolation` 开启，类型化的 preload 桥暴露 `__DSH_TRANSPORT__` 三钩子（`createApiClient`、`fetch`、`loadBundle`）。SPA 不变地渲染全部 web 功能，产品文案为中文。

禁套壳由架构而非外观满足：内核本地且被拥有、UI 加载本地文件、IPC 桥类型化、离线可用、工具执行走仓库已有的按操作系统沙箱提供方（`native/landlock-run`、`sandbox-local`、`sandbox-windows-acl`）。原生打开（`host.openPath`）与原生目录选择器经 Electron 的 dialog/shell API 路由——正是 directory-picker seam note 预言的提供方。

载体宿主半侧适配器——传输帧入、`FetchHandler.fetch` 出——被抽取为共享包，由 VSCode 扩展（postMessage 载体）与桌面端（MessagePort 载体）共同消费，依 VSCode A2 决策。

## 已考虑的替代方案

**Tauri（Rust 壳 + 系统 WebView）。** 体积与内存更小，但内核仍是 Node，Tauri 应用因此要背两个运行时和第二套 IPC 序列化；三个平台的 WebView（WebView2/WebKitGTK/WKWebView）差异威胁 SPA 的 CSS 假设；团队是 TypeScript 优先。否决。

**原生 Swift/Kotlin 应用。** 平台质感最强，也是据报道 Codex 桌面端采用的技术（本沙箱无法核实——外网调研被网络阻断；无论如何 Claude Desktop 的 Electron 先例已锚定对比基准）。原生 UI 意味着在三个平台重写成熟 web GUI，三倍成本。否决。

**壳内回环服务器（即 VSCode 的 A1 形态）。** 内核子进程绑定 `127.0.0.1`，renderer 经 HTTP 加载。客户端零改动即可工作，但桌面应用并不需要它却多开了一个网络监听；served 载体的信任围栏（回环钉死）恰恰因为浏览器载体无法再收窄才存在。IPC 桥的暴露面严格更小。桌面端否决。

**包装托管 web 应用。** 被产品要求明确禁止，且架构上更差：依赖部署的服务器、离线不可用、不拥有内核。

## 验收标准

- Windows 包可安装可启动；SPA 从本地文件渲染全部 web 功能，无网络监听。
- 内核以子进程运行；杀掉内核后呈现重连状态，外壳自动恢复且窗口不丢。
- Windows 上原生菜单、托盘常驻、回合结束通知可用。
- `dsh://` 深链聚焦应用并打开引用的会话。
- 工具执行组合按操作系统的沙箱提供方；`host.openPath` 经 shell 打开文件。
- electron-builder 产出 Windows 产物（签名或未签名）；macOS 签名/公证保留为 CI 侧后续（本机不可验证）。

## 风险

- Electron 的内存占用与 Claude Desktop 同级；作为形态成本接受。
- `utilityProcess` 内的进程内组合集中了生命周期复杂度——启动顺序、处置、重启——需要按仓库 defensive-patterns 评审。
- macOS 代码签名与公证无法在本机验证；首个 macOS 产物经 CI 落地并带此注记。
- Codex 桌面形态细节待外网可用时补证；不影响壳选型——Claude Desktop 先例已锚定。
