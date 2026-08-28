# Agent Note: dsh-vscode panel locale switching and session selection feedback

Status: implemented

[English](2026-08-25-dsh-vscode-panel-locale-and-session-selection.md) | 中文

## 问题

聊天面板此前只有英文文案，中文环境的用户只能在外语界面里工作。另一处：点击面板的新会话按钮看似毫无反应——宿主确实创建了会话，但 `sessions` 消息不携带当前选中会话的 id，webview 既不会选中新条目，也无法把它与已有的同名会话区分开。

## 决策

面板通过设置项本地化：`dsh-vscode.uiLocale` 接受 `auto`、`en`、`zh-cn`（`auto` 依据 VSCode 显示语言解析）。宿主在激活时和设置变更时解析出具体 locale，把两张字符串表连同当前 locale 注入 webview 文档、置于其脚本之前，并在设置变化时重绘文档。静态标记由导出的纯函数 `buildChatHtml(webview, locale)` 按 locale 生成；脚本内嵌双语文案并带英文回退。

会话选中改为 wire 上的显式宿主状态：`ready` 携带 `activeSessionId`，每条 `sessions` 消息携带 `activeId`，webview 渲染前先采纳它。新建会话现在会可见地切换过去。

## 已考虑的替代方案

**用 `@vscode/l10n` 配 `package.nls.*.json`。** 能让命令标题与设置描述跟随 VSCode 显示语言，但给不了扩展级自由选择——语言跟着编辑器走——而且 webview DOM 文案仍要在那边重复一套查询。面板自有的文案表用一个机制同时满足两个需求；将来为 manifest 文案引入 l10n 可无缝叠加。

**服务端按 locale 各生成一张表（只注入一张）。** 载荷更小，但切换语言反正要重生成 HTML，还失去了脚本渲染中途回退的能力；双表内嵌不足 1 KB，让「渲染 locale」成为唯一变量。

**创建后不自动选中（保持手动切换）。** 照顾批量建会话的用户，但点这个按钮的人期望就是落入新会话；下拉框一键即可切回。

## 后果

新增 UI 文案 = 在 `chat-view.ts` 的两张表各加一个键：缺键由 TypeScript 拒绝，`tests/chat-html.spec.ts` 固定 zh-cn 表面、en 静态标记、双表嵌入与 nonce 覆盖。切换 locale 会重载 webview、按设计清空临时会话记录。命令面板标题在补上 manifest 层本地化之前保持英文。
