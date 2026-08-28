# Agent Note: dsh-vscode 内核必须以真实 node 启动，而非扩展宿主 execPath

Status: implemented

[English](2026-08-27-dsh-vscode-kernel-node-resolution.md) | 中文

## Problem

真实扩展宿主里 `dsh.openChat`/`dsh.newSession` 报 `web kernel exited before listening (code 1)`。`startWebKernel` spawn 的是 `process.execPath`，在扩展宿主内即 Electron（`Code.exe`）：裸启动时 Electron 把内核 CLI 参数当作 Chromium 开关直接退出；加 `ELECTRON_RUN_AS_NODE=1` 后能进 CLI，但其 ESM 解析器拒绝 loader 的裸 workspace 包名（十多个 include 组导入报 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-client-ui-goal'`），而同一 pnpm 布局下纯 node 全部解析成功。单测只覆盖纯函数，问题只在宿主中暴露。

## Decision

`apps/vscode/src/kernel.ts` 现按顺序解析内核运行时：`DSH_NODE_EXE` 覆盖 → `PATH` 上第一个 `node`/`node.exe`（纯函数 `nodeSearchCandidates` 按平台推导候选）→ 宿主 execPath 兜底。`ELECTRON_RUN_AS_NODE=1` 恒置：它让兜底路径可用，纯 node 会忽略该标志。PATH 解析的平台分叉由单测固定。

## Alternatives considered

**保留 `process.execPath` 仅加标志。** 负向对照复现了崩溃，仅加标志的路径复现了解析失败；无论加什么标志，宿主运行时都不再作为内核启动器。

**复用已删除的 runtime-resolver 插件。** T4 重构连同其服务的预设机制一起删除了它；`kernel.ts` 内的单条解析顺序覆盖仅存消费者，不恢复那一层。

## Consequences

内核启动依赖 `PATH`（或 `DSH_NODE_EXE`）能找到 node——这是 dsh 用户的常态；一个都找不到时兜底仍会启动，其 stderr 带出真实失败而非 Electron 的 GUI 退出。从安装目录完成的验证：junction 的 `node_modules`、内核 URL 行、SPA index 拉取、两次 `session.create` 与 `session.list` 在纯 node 下全部通过。
