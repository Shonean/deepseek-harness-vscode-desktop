# Agent Note: 桌面外壳 D2 原生 chrome 与内核韧性

Status: implemented

[English](2026-08-25-dsh-desktop-d2-native-chrome.md) | 中文

## 问题

D1 桌面外壳（Electron 主进程 + 内核 `utilityProcess` + 类型化 MessagePort 载体）能开窗并中继 SPA 流量，但没有任何桌面 chrome——没有菜单、托盘、通知或深链——而且内核一旦崩溃会静默断开载体，窗口在没有可用后端的情况下空转到用户关窗。另外，D1 构建切换 ESM 后（scripts 在 `"type": "module"` 下产出 `dist/*.js`），`main.ts` 仍引用 `kernel-entry.cjs` / `preload.cjs`，应用根本无法启动。

## 决策

D2 补上原生 chrome，并让内核处于监管之下：

- **菜单与托盘。** 纯函数 `buildAppMenuTemplate(platform)` 驱动 `Menu.setApplicationMenu`（标准角色菜单）；从 `media/logo.svg` 安装尽力而为的 `Tray`（Show/Hide 切换与 Quit）。
- **`dsh://` 深链。** 应用注册为 `dsh` scheme 的默认处理者；`second-instance` / `open-url` 聚焦窗口，对 `dsh://session/<id>` 再预置 SPA 的持久化选中并重载。URL 语法收在纯函数 `parseDeepLink`。
- **回合结束通知。** 主进程自行直连内核回环上的 `events.mux` 端点，读取 SSE 流，在每个 `turn/end` 触发 `Notification`——与渲染进程自己的 mux 流相互独立（基类 API 客户端把 mux/host 当作 SSE-over-fetch 读取，因此载体把流桥进 SPA，而主进程可直读同一端点）。
- **内核重启。** `KernelSupervisor` 独占 `utilityProcess` 生命周期：启动失败上抛并停止；运行时崩溃则重拉内核、把载体接到新一代、重载窗口让 SPA 重连。通知流按代重新挂接。
- **启动修复。** `main.ts` 改引 `kernel-entry.js` / `preload.js`，与 ESM 构建产物对齐。

## 已考虑的替代方案

**主进程用 WebSocket 读 mux 流。** Electron 33 内置 Node 20，没有全局 `WebSocket` 客户端，需要引入 `ws` 依赖。内核 mux 端点是仅下行的 SSE 兼容流，Node 20 的全局 `fetch` 原生可读——无需新依赖。

**复用 SPA 自己的 mux 连接发通知。** SPA 的流活在渲染进程里，每次重载都会断；主进程自持的流与窗口重载无关，且不会活过它所在的代际。

**启动失败也重启。** 无法启动的内核会陷入重启循环；启动失败改为上抛并停止，只有运行时崩溃才重拉。

## 结果

- 外壳现在是受监管的桌面公民：菜单、托盘、深链与回合结束通知在 Windows 可用（macOS 路径已接线并置于平台检查之后，待 CI 验证）。
- 内核崩溃不再让窗口空转；载体重接后 SPA 重连，符合规格的 generation/reconnect 机制。
- 纯辅助（`menu`、`deeplink`、`notifications`）有单测；`tests/native.spec.ts` 钉死菜单模板、URL 语法与 SSE 回合结束匹配器。监管器本身保持 Electron 绑定、不做单测。
- 仍延后：`host.openPath` / 目录选择器缝的原生文件对话框（需 host 工具桥）、进程内内核启动（需 `dsh` 编程式启动入口）、共享宿主半侧载体包抽取，以及 D3 打包。
