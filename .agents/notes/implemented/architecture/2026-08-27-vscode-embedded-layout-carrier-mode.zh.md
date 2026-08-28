# Agent Note：内嵌载体模式隐藏 SPA 自带的会话栏

Status: implemented

[English](2026-08-27-vscode-embedded-layout-carrier-mode.md) | 中文

## 问题

VSCode 扩展把完整网页 SPA 嵌进编辑器面板（[隧道 note](2026-08-25-vscode-web-spa-tunnel.zh.md)），旁边是精简的活动栏侧边栏。SPA 自带会话管理 chrome——ui-sidebar 栏及其「新建会话」胶囊和 ui-workspace 浏览区——于是同一个 VSCode 窗口出现两个「新建会话」按钮、两份状态源独立的会话列表（宿主 broker 的 2 秒轮询 vs SPA 自己的客户端 store）。用户拍板 Claude Code 式布局：会话表面有且只有一个，安插在 VSCode 的左栏。

## 决策

内嵌与否由布局外壳决定，而不是由组合层决定。`createLayoutStore` 读取扩展的传输半侧在外壳启动前装好的同一载体标记（`window.__DSH_TRANSPORT__`，即 [client-web 启动](../../../packages/client/web/src/boot.ts)已经依赖的事实），在创建时把 `embedded` 标志冻结进 store。该模式下 AppFrame：

- 不渲染侧边栏列，不调用 sidebar slot，不渲染侧栏拖柄；
- 改用 `computeEmbeddedColumns` 求解列宽——共享同一条让步链、从零宽侧栏起步，中栏从整帧起步，详情栏保留原有的收缩/自动关闭行为；
- 跳过窄视口自动折叠机制（不存在任何侧栏形态的元素）。

组合层完全不动：roster 的每一行照常挂载，`sidebar` 及其内部座位保持声明状态，普通浏览器启动仍渲染不变的三栏形态。

## 已考虑的替代方案

曾否决通过 `--patch` overlay 直接禁用 `ui-sidebar`/`ui-workspace` 的方案：AppFrame 无条件保留侧栏栅格轨（关闭态解析为固定的 56px 控制栏），面板里会留下一条空带；而且声明方注册一消失，所有向 ui-sidebar 内部座位注册的插件都会大声失败。也曾否决给浏览器启动打通配置旋钮的路线：启动清单不携带每行配置、浏览器插件也不接收配置，载体标记是两侧唯一已共享且零管道改动的事实。

## 后果

- 编辑器面板呈现为纯对话表面；活动栏侧边栏成为唯一的「新建会话」按钮与唯一的会话列表，状态源只有一个（宿主 broker）。
- 载体检查在 store 创建时于 ui-layout 内运行一次：不新增依赖边（对既有全局的结构性读取），不改 manifest、内核参数或启动清单。
- 中栏内部的会话管理入口（创建会话的命令菜单项、空态 starter）在内嵌模式仍然可见；它们作用于同一个宿主可见的会话 store，属于刻意保留的内容，而非重复的导航 chrome。
- 未来的桌面客户端（[Electron note](../../proposed/architecture/2026-08-25-dsh-desktop-electron-shell.zh.md)）只要安装传输标记就会得到同样的两栏处理。
