# Agent Note: dsh VSIX packs from the publish tarball

Status: implemented

[English](2026-08-25-dsh-vscode-vsix-from-publish-tarball.md) | 中文

## 问题

`@deepseek-ai/dsh-vscode` 以 npm 发布成员形态发布，但编辑器用户安装的是 `.vsix` 文件。标准 `@vscode/vsce` 流水线按它自己的包含规则打包工作区，因此可安装产物与发布 tarball 会成为两条独立派生的载荷并可能漂移：vsce 构建的 VSIX 可能带上发布政策排除的文件，也可能漏掉政策要求的文件。此外该扩展一直没有针对其捆绑运行时组合的真机 API 测试。

## 决策

`pack:vsix`（`apps/vscode/scripts/pack-vsix.mjs`）从发布 tarball 构建 VSIX。先由 `pnpm pack` 产出精确的 npm 载荷；脚本把其中的 `package/` 目录解包为 VSIX 的 `extension/` 目录，合成 `[Content_Types].xml` 与 `extension.vsixmanifest`，再用 `fflate` 压缩为 `dist/dsh-vscode-<version>.vsix`。暂存 manifest 的 name 会从带 scope 的包名改写为 `dsh-vscode`：VSCode 从 manifest name 派生磁盘上的扩展目录名，而该名称不能含 scope 分隔符；`publisher.name` 里的市场身份本就是无 scope 的。两道防线保证旧产物不会被打进新产物自身：`files` 字段把 `dist/**/*.vsix` 排除出 tarball，脚本在打包前删除上一次输出。

应用同时新增一条真机 API e2e：`apps/vscode/tests/openrouter-runtime.e2e.ts` 在 tsx 下启动捆绑的 `runtime/cordis.yml`，经 stdio JSON-RPC（`initialize` → `session/prompt` → assistant 文本 → `turn/end`）通过 OpenRouter 路由完成一个真实回合，并断言干净退出。密钥解析顺序为 `OPENROUTER_API_KEY`、opencode 自身的登录记录 `~/.local/share/opencode/auth.json`；两者皆缺时与其他真机 e2e 一样自行跳过。路由经由 settings 接缝挂载（`llm-pi-ai.providers.openrouter`），与用户预设同一条路径，不为一个提供方去改捆绑组合。

## 已考虑的替代方案

**用 `@vscode/vsce` 打包。** 官方工具会按市场规则校验 manifest，也是将来上架市场会用的路径，但它打包的是工作区，VSIX 不再从发布载荷派生，而且给发布路径引入一个全局安装的工具。从 tarball 构建保持唯一事实源；若将来要上架市场，vsce 仍可在同一 tarball 纪律之上叠加。

**只发 tarball 并写文档指导手动安装。** 无需拥有任何打包代码，但每个用户安装时都要手工重复解包与压缩步骤，且没有任何东西验证发布的载荷真的能装进 VSCode。脚本化的 VSIX 把可安装性变成被检查的产品面。

**e2e 改用 `DEEPSEEK_API_KEY`。** 复用仓库级密钥变量可以避免第二处凭证来源，但 OpenRouter 路由正是扩展预设流程为非官方提供方配置的那条路，DeepSeek 路由已有既有套件覆盖。读取 opencode 的登录记录测试了用户真实运行的路由，又不必新增存储秘密。

## 后果

`fflate` 成为应用的 devDependency，VSIX 构建在任何能跑 `pnpm pack` 的地方都能执行——除 Node 与 `tar` 外不需要平台工具。每次重新打包都要求版本号前进或先删除旧输出；同版本的情况由脚本自行处理。e2e 模型必须同时满足两个约束：属于 pi-ai 已安装目录（否则 `UNKNOWN_MODEL`），且在运行区域可达——OpenAI 托管的模型返回 403 "not available in your region"，免费变体也频繁下架，因此测试固定使用 `cohere/north-mini-code:free`，并接受免费档限流带来的偶发失败，由共享的 vitest 重试吸收。
