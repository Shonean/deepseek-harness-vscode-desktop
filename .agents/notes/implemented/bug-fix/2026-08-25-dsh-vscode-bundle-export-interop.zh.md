# Agent Note: dsh-vscode bundle export interop breaks activation when footered

Status: implemented

[English](2026-08-25-dsh-vscode-bundle-export-interop.md) | 中文

## 问题

安装后的 `dsh-vscode` 扩展侧边栏视图永远打不开：每次激活都在加载 `dist/extension.cjs` 时死于 `TypeError: Cannot set property activate of #<Object> which has only a getter`。bundle 末尾的 footer 对 `module.exports.activate` 赋值，但 esbuild 0.25 的 CJS entry 输出已经通过 `__export` 把 entry 的 ESM 命名导出定义为只有 getter 的属性，而赋值在 bundle 的 `"use strict"` 下直接抛错。此前没有测试加载过构建产物，故障只在真实扩展宿主里现形。

## 决策

`apps/vscode/scripts/build.mjs` 不再追加导出 footer：esbuild 自身的命名导出标注正是扩展宿主所需要的，`require('dist/extension.cjs')` 直接暴露 `activate`/`deactivate`。新增无密钥单元套件（`apps/vscode/tests/bundle-activation.spec.ts`）以 stub 掉的 `vscode` 模块经 Node CJS loader 加载构建产物，断言两个钩子是函数——把宿主每次激活都会走过的加载期契约固定下来。

## 已考虑的替代方案

**保留 footer 但改用 `defineProperty` 或先删后赋。** 保住历史代码形态的同时绕开 getter，但 footer 的前提早已失效——esbuild 本来就会落好导出——正确的最小改动是删除，而不是在已正常工作的输出上再叠一层变通。

**增加 startup 激活事件让故障无需点击即现形。** 启动即激活会让这类损坏更早出现在日志里，但它会为从不打开视图的用户急切拉起运行时子进程机制；回归测试已在同一层确定性覆盖，不必改变激活语义。

## 后果

复现激活类回归不再需要启动 VSCode：单元套件在 `dist/extension.cjs` 存在的任何地方都能运行，未构建时自行跳过。升级或更换 esbuild 必须保持「CJS entry 输出把 ESM 命名导出落到 `module.exports`」这一性质；一旦改变，套件会立即失败。
