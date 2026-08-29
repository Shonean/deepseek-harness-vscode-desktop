# Agent Note：VSIX 自带自包含的内核运行时闭包

Status: implemented

[English](2026-08-28-vscode-vsix-runtime-closure.md) | 中文

## 问题

打包出的 VSIX 只携带扩展 bundle 与 media。干净机器上内核起不来：`resolveDshBin` 要从扩展目录解析 `@deepseek-ai/dsh`，但安装态 VSIX 旁边没有 `node_modules`，且内核自带的 `cordis.yml` 按裸包名加载 web profile 插件，这些解析全部失败。可行的临时手段是从 `~/.vscode/extensions/node_modules` 手工建 junction 指向已构建检出的 `apps/vscode/node_modules`——这是无法要求用户做的安装步骤，且每次升级都会丢失。

## 决策

VSIX 在 `extension/runtime/` 下携带 pnpm deploy 生产闭包，解析优先指向它。

- 新增仅声明依赖的工作区包 `apps/vscode/runtime-deploy`（`dsh-web-runtime-closure`），其依赖清单即闭包内容：`dsh` CLI、所服务的网页前端、web profile 与自带 agent preset 按裸包名加载的全部插件，以及 `auto-install-peers=false` 下 Cordis 必需的非可选工作区 peer。新增分发插件只需在这里加一行依赖，与 python-sdk 运行时同模型。
- `scripts/build-runtime-closure.mjs` 用 `pnpm deploy --legacy --prod --node-linker=hoisted --auto-install-peers=false --link-workspace-packages=true` 把闭包物化到 `apps/vscode/runtime/`，把 pnpm 可能以链接形式留在检出 vendor 源上的 vendored 框架包物化为解引用的真实拷贝（deploy 遗留为链接的已声明依赖同样替换），裁剪非运行时文件（source map、`.d.ts`、`tsconfig.json`、测试目录），并在 `dsh` bin、前端 `dist/index.html` 或任一已声明插件缺失时响亮失败；闭包内残留任何 symlink 也响亮失败——链接只在本次检出内可解析、且会被 pnpm pack 直接丢弃，于是工作区闭包能启动而安装态闭包以 `ERR_MODULE_NOT_FOUND` 崩溃。
- 包的 `files` 字段加入 `runtime/node_modules/**` 与 `runtime/package.json`，发布 tarball——进而 `scripts/pack-vsix.mjs` 产出的 VSIX——随之携带闭包；`pack:vsix` 串联 `build` + 闭包物化 + 打包。
- `src/runtime-resolution.ts` 在闭包存在时把 `createRequire` 锚到 `runtime/package.json`，源码检出回退到扩展 `package.json`；`kernel.ts` 记录 `resolvedFrom=`（胜出根），安装态可从输出通道直接诊断。内核仍跑在系统 Node 上（[kernel-node-resolution note](../bug-fix/2026-08-27-dsh-vscode-kernel-node-resolution.zh.md)），本次只改依赖解析。

## 已考虑的替代方案

- 直接把工作区检出的 `node_modules` 打进包（`files: ["node_modules/**"]`）：被否决。pnpm 的符号链接工作区布局经不住 tarball 打包，且闭包内容取决于工作树当前恰好有什么，而非声明好的生产依赖图。
- 用 esbuild 把内核打进扩展 bundle：被否决。内核是独立 Node 进程且有动态裸包名插件加载；打进 bundle 会让它与 CLI 打包形态分叉，破坏 resolver manifest 契约。
- 继续保留 junction 要求：直接否决，它不可能成为用户安装步骤。

## 后果

- 干净安装无需 junction：内核与 SPA 从安装的闭包启动（`resolvedFrom=` 以 `runtime` 结尾）。
- VSIX 从约 0.2 MB 增长到约 40 MB 压缩（解压约 120 MB、`.d.ts` 裁剪后约 1.26 万文件），安装明显变慢；README 已在已知限制中说明。
- 闭包是一棵扁平 hoisted 树、工作区链接已解引用，保持单一 Cordis 实例；裁剪从不跟随符号链接，因此不会越出闭包伤及检出。
- 桌面 portable 打包自带负载时可直接复用同一 `runtime/` 闭包目录；闭包构建没有任何 VSIX 特化。
- 首个闭包 VSIX 用 fflate 流式 `Zip` 打包时损坏了三个条目；打包器已改为批量 `zipSync` 并强制回读校验（[zip 损坏 note](../bug-fix/2026-08-28-vscode-vsix-streaming-zip-corruption.zh.md)）。
- 验证：闭包探针全绿（bin 与前端从 `runtime/` 解析成功、内核打印 URL、`/` 与 `/plugins/...` 均 200）；修复后，从 VSIX 解出的安装态闭包（无 junction）在工作区外部 cwd 下启动真实内核——独立宿主模拟脚本创建会话并到达 `kernel: listening`，裸 `node <closure>/lib/bin.js --profile web` 同样通过；12,650 个文件全部落盘。`apps/vscode` 单测/tsc/oxlint 全绿。注意：vitest 的 `host-sim.spec.ts` 对修复前的坏闭包也通过——同一 import 图在裸 spawn 下失败、却在 vitest worker 环境内成功解析，原因未明——因此在弄清机理前，安装态验证不能只依赖 vitest harness。
