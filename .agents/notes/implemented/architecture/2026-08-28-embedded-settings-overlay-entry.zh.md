# Agent Note：内嵌载体经 shell.overlay 入口触达设置

Status: implemented

[English](2026-08-28-embedded-settings-overlay-entry.md) | 中文

## 问题

内嵌载体布局（[载体模式 note](2026-08-27-vscode-embedded-layout-carrier-mode.zh.md)）在 VSCode 面板与桌面外壳中隐藏了 SPA 的侧边栏列，因为原生宿主自己拥有会话导航。`ui-settings-general` 此前把整个设置外壳注册进 `sidebar.settings`——齿轮触发器、设置模态与 API Key onboarding 全部挂在这一个座位上。载体模式下侧边栏列不渲染，齿轮就永不挂载，设置模态与凭据 onboarding 随之不可达：VSCode 里的首次用户在面板中找不到任何配置 API Key 的入口。

## 决策

设置插件保持一个外壳，在组合时选择占用座位。`packages/client/ui-settings-general/src/client/index.ts` 的 `apply` 读取一次载体标记（本地的 `hasTransportCarrier()`，镜像 ui-layout 对 `window.__DSH_TRANSPORT__` 的读取；客户端包禁止跨包值导入）：

- 普通浏览器：不变——外壳注册进 `sidebar.settings`；
- 内嵌载体：一个薄封装 `OverlaySettingsEntry` 注册进 ui-layout 的根作用域列表槽 `shell.overlay`，在帧右上角锚定一颗悬浮栏式齿轮，并以 `wide: false`（栏式图标、无文字）挂载同一个 `SettingsRoot`。

两个分支里占用方声明完全相同的六个设置子槽（`settings.trigger/header/action/close/section/onboarding`）；每个载体只占一个座位，因此声明不会冲突。设置模态面板与 onboarding 本就以固定的全视口层渲染，从哪个座位挂载都表现一致。

AppFrame 把详情面板宽度暴露为帧级自定义属性 `--dsh-details-w`；悬浮锚点从详情栏边缘偏移（`right: calc(var(--dsh-details-w) + 12px)`），齿轮不会画在展开的详情面板之上。

## 已考虑的替代方案

- 仅为齿轮把侧边栏列以折叠栏形式重新渲染：被否决。它会复活载体模式移除的 56px 空轨，并在一个本就拥有导航的宿主里重新引入第二个导航形态表面。
- 宿主侧 VSCode 命令打开原生设置页：被否决。设置内容（分区、onboarding 步骤、凭据流程）全部由客户端插件组合；在宿主侧复制等于分叉该表面。
- 导入 ui-layout 的 `hasTransportCarrier`：被跨包值导入规则否决。该标记是稳定、有文档的全局，本地三行结构性读取是被认可的路线。

## 后果

- 设置、API Key onboarding 与每个 `settings.action` 行在 VSCode 面板和桌面外壳中经右上角齿轮可达；浏览器部署字节级不变（无标记时 overlay 分支不运行）。
- 齿轮位于帧级 overlay 而非对话区元素，跨会话与详情状态始终可见；z-index 与 pointer-events 仅作用于锚点自身（overlay 层保持点击穿透）。
- 未来的内嵌载体只要安装传输标记即自动获得该入口，无需逐宿主接线设置。
- 验证：`ui-settings-general` + `ui-layout` 单测套件（114 个测试，含载体分支注册与 HMR 拆除断言）、完整 `test:gui`、应用 tsc 与 oxlint 全绿。浏览器组装表面不变，故 web 快照输出无变化；本 Windows 检出未重跑 `test:web` 回放（dist 重建耗时长，且有在案的 Windows 平台性 fixture 失败）。
