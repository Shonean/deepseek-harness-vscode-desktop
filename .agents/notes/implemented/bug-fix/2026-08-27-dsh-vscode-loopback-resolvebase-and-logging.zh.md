# Agent Note: dsh-vscode 回环客户端曾指向 dsh.internal 假权威，且宿主侧无日志

Status: implemented

[English](2026-08-27-dsh-vscode-loopback-resolvebase-and-logging.md) | 中文

## Problem

内核运行时修复后，真实宿主里 `dsh.openChat`/`dsh.newSession` 仍以裸 `fetch failed` 失败。`AbstractApiClient.resolveBase()` 在浏览器返回 `globalThis.location.origin`，否则返回 `dsh.internal` 假权威——该基址为进程内 handler 注入设计，绝不该真发 DNS。`LoopbackApiClient` 只 override 了 `doFetch`，于是在扩展宿主里每次 broker 调用都解析 `http://dsh.internal/api/...`，经 DNS 出机，死在沙箱 fake-ip 解析器上。webview 侧 `TunnelApiClient` 侥幸存活只因 `bridgeFetch` 只消费 path。而扩展没有任何输出通道，真实窗口里既看不到哪个请求失败、也看不到 kernel 子进程为何而死。

## Decision

两个隧道客户端现在都 override `resolveBase()`：回环客户端返回内核基址，webview 客户端固定假权威并注释说明 `bridgeFetch` 只消费 path 加 query。新增 `log.ts` 在激活时绑定唯一的 "DeepSeek Harness" 输出通道，各层统一经其记录——spawn 命令/cwd/bin、kernel stdout/stderr 逐行、退出码带 stderr 尾部、broker 就绪、逐请求 tunnel method/path/status/耗时、命令入口；`dsh.showLogs` 打开该通道。webview 侧失败同样进该通道：面板 transport 与侧栏脚本都把 `window.onerror`/`unhandledrejection` 上报给宿主记录。未打开工作区文件夹时内核 cwd 回落到用户主目录——扩展宿主的 `process.cwd()` 是 VSCode 安装目录，agent 会话绝不能指向它。编辑器 Tab 改用粉色 light/dark PNG，因为 `WebviewPanel.iconPath` 忽略 SVG。无密钥的宿主模拟套件（`apps/vscode/tests/host-sim.spec.ts`）以 stub `vscode` 模块加载构建产物、激活、对真实 kernel 子进程执行真实 `dsh.newSession` handler、端到端中继一次 tunnel fetch 并断言日志行；`DSH_HOST_SIM_EXT` 可将其指向已安装的扩展目录。

## Alternatives considered

**只修回环客户端。** webview 客户端目前靠 `bridgeFetch` 忽略 origin 的巧合工作；在两个子类固定 `resolveBase` 把巧合变成明示契约。

**写到扩展日志目录下的文件。** 输出通道本就留存于 VSCode 日志目录且一键可达（`dsh.showLogs`）；第二个去向只会分散证据而不增加可达性。

## Consequences

broker 调用不再可能出机：回环基址即内核端口，webview 路径从不携带 origin。宿主侧失败现在产生可读记录——kernel spawn 行、stdout/stderr、退出码、失败的确切 tunnel 请求——而非裸 `fetch failed`。宿主模拟套件补上了让前两次回归直达真实窗口的缺口：它运行用户所跑的那份 bundle，而不只是源码辅助函数。
