# Agent Note: VSCode 面板跟随当前配色主题

Status: implemented

[English](2026-08-25-dsh-vscode-panel-theme-bridge.md) | 中文

## 问题

web SPA 完全通过 `matchMedia('(prefers-color-scheme: dark)')` 解析 `system` 主题偏好——首次绘制时一次（`boot-theme.ts` 注入的 body 内联脚本），之后由客户端运行时的媒体查询实时更新承接。在 VSCode webview 内，该查询反映的是宿主环境的偏好，而非 VSCode 当前的配色主题。因此面板可能在浅色 VSCode 中渲染成深色（或反之），切换 VSCode 主题也永远不会传达到 SPA。

## 决策

扩展桥接 SPA 已经在用的那个缝，而不是重新给 SPA 换肤。`webview-index.ts` 导出纯函数 `themeBridgeScript(initialKind)`，覆盖 `window.matchMedia` 对两条配色查询的回答，改由 VSCode 主题类型（`light` | `dark` | `hc-light` | `hc-dark`，从 `ColorThemeKind` 映射而来）决定；其余查询一律委托原生实现，且覆盖层会重新派发 change 事件，让 SPA 的实时主题运行时照常工作。`web-panel.ts` 在渲染时把当前主题类型随脚本一起注入到 SPA 之前，并通过 `window.onDidChangeActiveColorTheme` 以 `dsh.vscodeTheme` 消息推送实时更新，桥接脚本监听该消息。

## 已考虑的替代方案

**用注入的 CSS 响应 VSCode 的 `body.vscode-dark` 类。** 只能重染静态外观，驱动不了 SPA 自身的 `matchMedia` 逻辑；SPA 仍会以错误的配色启动，其运行时切换也依然脱节。

**用轮询或 DOM 变更监听追踪主题变化。** 脆弱且重复；VSCode 本就提供显式的 `onDidChangeActiveColorTheme` 事件，这才是唯一权威来源。

**让 SPA 保持 `system`。** 面板会跟随操作系统，偏离用户实际所在的编辑器；VSCode 形态要求面板与编辑器一致。

## 结果

- 面板在首次绘制时就与 VSCode 同配色渲染，并实时跟踪主题切换，含高对比度变体。
- 覆盖仅限两条配色查询；SPA 中任何其他媒体查询消费者不受影响。
- 桥接逻辑位于纯函数 `webview-index.ts` 面，由 `tests/webview-index.spec.ts` 的单测钉死（深/浅回答、配色查询不外泄、其他查询正常委托、收到宿主主题消息后翻转并派发）。
