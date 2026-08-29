# Agent Note：社区 VSCode 扩展与桌面外壳的非官方品牌合规

Status: implemented

[English](2026-08-28-vscode-desktop-brand-compliance.md) | 中文

## 问题

社区发布的 VSCode 扩展（`apps/vscode`）与桌面外壳（`apps/desktop`）此前以上游身份出货：扩展 publisher 为 `deepseek-ai`，显示名与命令标题含完整商标「DeepSeek Harness」，桌面 appId 为 `ai.deepseek.harness.desktop`，仓库 URL 指向上游组织。[BRAND_GUIDELINES.md](../../../BRAND_GUIDELINES.md) 要求社区项目在命名中使用缩写「DSH」、项目/扩展名避免完整商标、避免给人官方背书的印象。用户拍板：publisher `shonean`、扩展显示名「DSH for VS Code」、桌面「DSH Desktop」/ `com.shonean.dsh-desktop`，粉色鲸鱼图标保留（用户明确接受的偏差，如实记录）。

## 决策

按表面逐项落实指南，「DeepSeek Harness」仅保留在如实描述关系的文字中：

- VSCode 清单：publisher `shonean`，displayName `DSH for VS Code`，description 以「Unofficial community build.」开头；活动栏容器标题、命令标题（`DSH: Open DSH Panel`、`DSH: New DSH Session`、`DSH: Close DSH Panel`、`DSH: Show DSH Logs`）、配置标题与输出通道名一律用「DSH」；仓库 URL 指向社区 fork；`keywords` 含 `dsh-plugin`。
- 扩展宿主代码中的用户可见字符串（面板标题、进度通知、侧边栏/webview 文档标题、日志通道）改用「DSH」。
- 桌面端：package `productName` 为 `DSH Desktop`；electron-builder `appId: com.shonean.dsh-desktop`、便携产物 `DSH-Desktop-<version>.exe`；窗口标题、通知、托盘 tooltip、Windows AppUserModelId 与打包脚本同步；仓库 URL 指向 fork。
- 两份 README（英/中）重写为用户向：徽章（非官方/上游/许可证）、明确的非官方维护者声明与商标说明、安装步骤与前置要求。
- npm 包名保持 `@deepseek-ai/dsh-vscode` / `@deepseek-ai/dsh-desktop`：工作区命名约定（`@deepseek-ai/dsh-*`）是内部标识，且 VSIX 打包器已把暂存清单名改写为无 scope 的 `dsh-vscode`；市场身份是 `publisher.name` = `shonean.dsh-vscode`。
- SPA 自身的产品内品牌（web manifest 名、系统提示、快照 fixture）属上游项目内容，不动。

## 已考虑的替代方案

- 重命名 npm 包（`@deepseek-ai/dsh-vscode` → 无 scope 或 `shonean` scope 名）：考虑后否决。工作区命名约定是内部标识，VSIX 打包器已把暂存名去 scope 为 `dsh-vscode`，市场身份是 `publisher.name`；重命名只会徒增全工作区引用改动，无用户可见收益。
- 用中性标记替换粉色鲸鱼图标以完全贴合指南：考虑后被用户明确否决；偏差已记录如上。
- 保留完整「DeepSeek Harness」名称仅加免责声明前缀：被否决。指南明确要求名称使用「DSH」，而市场/显示名正是最容易暗示官方背书的表面。

## 后果

- 安装后的扩展身份为 `shonean.dsh-vscode`；若存在旧的 `deepseek-ai.dsh-vscode` 条目须卸载，避免两个同名扩展。重打 VSIX 已验证：manifest 显示 Publisher `shonean`、DisplayName `DSH for VS Code`；真机安装成功，从安装态解析内核启动与 SPA 根均正常（仍需 junction 到工作区 `node_modules`——VSIX 运行时闭包缺口另案跟踪）。
- 品牌改动只涉及清单、宿主代码字符串与 README，无插件或线路协议变更；应用单测（99 个）、tsc、oxlint 保持全绿；两份 README 双语配对已重新记录。
- 粉色鲸鱼图标经用户明确决定保留为扩展/桌面图标；这是唯一与指南相邻的偏差，记录于此而非默认保留。
- 发布/宣传物料（Discussions 自荐帖与 Discord 自我介绍草稿）随本变更产出，属社区面向文本，不入库。
