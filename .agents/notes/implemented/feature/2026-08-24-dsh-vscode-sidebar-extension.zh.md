# Agent Note: dsh VSCode sidebar extension over the JSON-RPC runtime

Status: implemented

[English](2026-08-24-dsh-vscode-sidebar-extension.md) | 中文

## 问题

dsh 此前只有 CLI、headless、ACP 和浏览器 Web 形态，没有编辑器集成，在 VSCode 里工作意味着离开编辑器或手工驱动原始 JSON-RPC。两个相邻缺口加剧了这一点：把子任务委托给其他 agent CLI（Claude Code、OpenCode）需要为每个 CLI 手工搭建工具，而 OpenAI 兼容网关在配置编辑之外没有可切换的路由方案。

## 决策

`apps/vscode`（`@deepseek-ai/dsh-vscode`）是一个发布成员形态的 VSCode 扩展，提供原生侧边栏聊天面板。其宿主进程持有一个 dsh 运行时子进程——以捆绑的 `runtime/cordis.yml` 启动 `@deepseek-ai/dsh-jsonrpc-agent` bin——并通过 `@deepseek-ai/dsh-sdk-client` 以现有 stdio NDJSON JSON-RPC 协议通信。wire 协议、agent loop 与 SDK 服务端保持不动；扩展只是冻结接缝的消费者，面板的每项能力（流式文本、工具调用折叠行、子代理活动行、文件路径链接、会话列表）都由 wire 上既有通知渲染。

### 组装与子代理即配置

`runtime/cordis.yml` 挂载 JSON-RPC 服务端、文件设置与本地凭证、DeepSeek 加 pi-ai 多 provider LLM 路由、bash/fs 工具及其本地 provider、JSONL 会话持久化（含 checkpoint 策略与 projection）、token meter、compaction、todo 以及 subagent 族。Claude Code（`@deepseek-ai/dsh-subagent-claude-code`）与 OpenCode（`@deepseek-ai/dsh-subagent-acp`）以纯配置行挂载；两个 `@deepseek-ai/dsh-tool-subagent` 实例把它们暴露为 `subagent_claude_code` 与 `subagent_opencode`。委托能力完全以配置交付——应用内没有任何新的委托代码。

### API 预设共享 ainovel 的预设库

`ApiPresetStore` 把 `~/.claude/ainovel-write/api_library.json` 视为 API 路由的唯一事实来源：`text_presets[].fields` 中 `ARK_API_KEY` / `ARK_BASE_URL` / `ARK_MODEL_PRO` 三个键与扩展预设一一对应，`current_text_id` 即与 ainovel 本身共享的活动选择。面板下拉、quick pick 与新增预设流程都经 store 读写该文件。运行时启动时，活动预设的值成为子进程的环境变量（`OPENAI_API_KEY`、`OPENAI_BASE_URL`，外加 `ARK_*` 镜像）；切换到不同模型或 base URL 的预设会拆除子进程，使下一次提示词重新执行携带新路由的 `initialize`。预设切换从不触碰 provider 路由代码——路由经 pi-ai 目录与 OpenAI 兼容路由键解析。

### 停止语义与生命周期

面板没有回合中途取消：停止会关闭 SDK client，由其对进程树执行 stdin EOF → SIGTERM → SIGKILL 升级。多个命名会话复用同一运行时子进程，在首次提示词时懒启动；标题取自会话的首条用户消息。

## 已否决的备选

**把预设存进 `dsh-vscode.apiPresets` 设置并只存凭证变量名。** 设置集成是地道的 VSCode 方式且避免明文密钥进入外部文件，但它把用户既有的手工编辑面裂成第二个必须保持同步的库。共享 ainovel 文件保留唯一库与唯一选择；接受的代价是扩展继承 ainovel 的 schema 及其明文密钥约定，而非定义更严格的一套。

**为回合中止增加 cancel RPC。** 让面板可取消回合而不杀运行时能保住兄弟会话并省去启动成本，但 wire 协议没有取消词汇，新增会级联到服务端语义和两个 SDK client。进程终止复用 client 经测试的 dispose 阶梯；同子进程中的兄弟会话随之终止，面板接受这就是「停止」的含义。

**在扩展宿主内进程内运行运行时组装。** 进程内挂载省掉全部子进程管理，但 stdout 分帧属于 SDK 服务端，Cordis dispose 将与扩展宿主拆卸时序耦合，运行时崩溃还会连带拖垮编辑器进程。子进程这条线保留崩溃隔离，并允许 resolver 回退到用户配置的命令。

**经外部渲染器包把助手输出渲染成 Markdown。** 刻意放弃更丰富的排版：webview CSP 禁止外部资源，自包含脚本把评审面与供应链压到最小，而工具行与路径 linkification 已提供用户所需的结构。

## 验证

无密钥包测试用 fake harness 驱动 `HarnessController`：首次提示词懒启动、活动预设变更模型或 base URL 时重启、未选预设时拒绝、停止时终止运行时。一条 smoke spec 在 tsx 下启动真实捆绑的 `cordis.yml`，经 stdio 初始化，对本地 stub 模型服务器发送提示词，断言两个委托工具出现在请求载荷中，并以退出码 0 干净关闭。一条 OpenRouter e2e 用 opencode 的已登录密钥经同一捆绑组合完成一个真实回合，无密钥时自行跳过。类型检查、lint、knip 与 workspace constraints 覆盖包面；真实 API 端到端需要 `DEEPSEEK_API_KEY` 加本机安装的 `claude` 与 `opencode`。

## 后果

凭证存放在用户主目录 ainovel 的明文文件中；该文件早于扩展存在并仍是它的契约，因此没有新增秘密存储，但扩展能读到它们。外部子代理没有 `subagent.finished` 通知，其进度只能经由所属工具行的状态呈现。跨进程会话续聊仍在范围之外——SDK 服务端对同名会话是新建而非恢复——关闭 VSCode 会放弃进行中的回合，历史只能经持久化的 JSONL 日志回放，面板不能。发布遵循仓库的 npm release-member 政策（public access、无 source maps、`dist` + `runtime` + `media` 载荷），可安装的 VSIX 从同一 tarball 打包（[VSIX 打包](../process/2026-08-25-dsh-vscode-vsix-from-publish-tarball.zh.md)）。Windows 下的进程树终止依赖 client 的升级阶梯，单元 fake 对它的覆盖只是间接的。
