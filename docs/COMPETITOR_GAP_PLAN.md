# 竞品对照建设计划（Gemini CLI 0.52 / Codex 0.144 / OpenCode 1.18）

## 1. 先说结论

我们在**桌面形态、审批粒度、变更审阅**三件事上确实领先：逐操作路径分类审批 + 命令/diff 预览 + 会话白名单可审阅撤销、git worktree 隔离 + hunk 级回滚、Chat/Agent/Studio 三面一体，这些竞品要么没有要么更粗糙。

真正的差距不在"炫技功能"，而在**代理的基础感知能力**：没有 glob、没有正则搜索、没有按行读文件、不读 `.gitignore`——在真实仓库里模型是半瞎的；`/init` 生成的 `AGENTS.md` 从来没有被读回过任何一轮对话；模型不知道今天几号、跑在什么系统上、工作区长什么样。

其次是**已建好却用不上的资产**：ExtensionHost（插件 + MCP + hooks）后端完整，但渲染层没有任何启用路径，且 MCP 只在 `full` 模式加载——我们付了全部成本，用户拿到零。BrowserControlService 同理，两端都是死代码。

最后是**日常体感缺陷**：转录不自动滚动、审批阻塞时不发系统通知、失败的一轮只能看到"请重试"却没有重试按钮。这三条都是小工作量，但每天都在扣分。

建议顺序：先补感知（检索 + AGENTS.md + 环境块），再打通已有资产（插件/MCP 开关），再补安全网（自动检查点），最后才是并发和后台进程这类大工程。

---

## 2. 立刻做（高价值，小/中工作量）

### 2.1 注入环境上下文块 —— 工作量：小
- **我们现在**：`protocolSessionInstructions()` 拼的全是冻结的静态字符串，`agent-turn-service.ts` 里 `process.platform` / `new Date()` 零命中（已验证）。模型不知道日期、操作系统、工作区名字、当前分支。
- **他们**：Codex 序列化 `<environment_context>`（cwd / shell / current_date / timezone / workspace_roots / 权限画像）；OpenCode 的 `<env>` 块带工作目录、是否 git 仓库、平台、今天日期。
- **用户得到**：模型不再生成 `ls`/`rm -rf` 这类被我们 argv 校验直接拒掉的 POSIX 命令（Windows 上每次都白费一个往返 + 一次审批弹窗）；不再写错日期；不再每轮开场先 `list_directory('.')` 探路——那一次调用最多灌 64KB 目录文本进上下文。
- **第一步文件**：`src/main/services/agent-turn-service.ts:186-256`（在冻结的 developer message 常量旁加一个动态 environment 块，1384-1399 处拼进去）。全部数据主进程已有，不需要新 IPC。

### 2.2 转录跟随流式输出 —— 工作量：小
- **我们现在**：`<div className="transcript">` 没有 ref，`styles.css` 只有 `overflow-y: auto`，全渲染层 grep `scrollIntoView|scrollTop|scrollTo(` 在 App.tsx 里零命中（已验证）。Chrome 的滚动锚定会把视图钉死，回答一超过一屏用户就得手动滚。
- **他们**：所有竞品的会话面板默认跟随，并提供"回到底部"。
- **用户得到**：每一轮超过一屏的回答（Agent 带执行轨道的基本都是）不再需要手动追。这是目前最显眼的"这软件是不是坏了"的观感缺陷。
- **第一步文件**：`src/renderer/src/App.tsx:1648`（加 ref + 贴底判定），`src/renderer/src/styles.css:425-432`。

### 2.3 审批阻塞与前台完成要发系统通知 —— 工作量：小
- **我们现在**：`new Notification(...)` 只在 `publishAgentEvent` 里、且只对 `agentTaskSupervisor.list()` 命中的**已分离后台任务**发；`approval-request` / `waiting-approval` 只更新状态、不通知；没有窗口焦点判断，设置里也没有通知面板。
- **他们**：OpenCode 按类别分「Agent 完成 / 错误 / 权限请求」三档，系统通知 + 声音；Codex 走用户配置的外部 `notify` 程序。
- **用户得到**：`request`/`auto` 模式下代理停在审批上、用户已经切走——现在没有任何东西告诉他。这是纯粹的挂钟时间浪费，而事件已经流经同一个函数，几乎白捡。
- **第一步文件**：`src/main/ipc/register-ipc.ts:240-268`。

### 2.4 打通插件/MCP 开关，并让 MCP 脱离 `full` 模式 —— 工作量：小到中 ——【已完成 2026-07-27：extension-host 去掉 full 模式门（逐工具审批保留），Settings 插件页支持发现与启用（原生确认），composer 提示指向设置页】
- **我们现在**：ExtensionHost 能发现清单、原生同意提示、连接 MCP、跑四个 hook，全部就绪；但 `Settings.tsx:667` 写着"插件功能当前尚未开放"、安装按钮 disabled，`composer-capabilities.ts:647` 拒绝未启用插件，`plugin.enabled` 永远不可能为真。同时 `extension-host.ts:275` 把 `.mcp.json` 发现整个包在 `if (context.approvalMode === 'full')` 里。
- **他们**：Gemini CLI 的 `/extensions`、`/mcp` 全套子命令；Codex 有 `plugin/install|list` 加市场；OpenCode 有 Status 弹层的 MCP/Plugins 页。三家都把 MCP 连接和沙箱等级正交处理，逐工具调用再过策略。
- **用户得到**：用户能装 Playwright MCP、公司内部工具服务器、完成后通知的 hook——今天一个都开不了。而且现在想用一个**只读**的文档查询 MCP，必须先授予全盘绝对路径 + shell 权限，这是把谨慎用户往最危险的模式上推。单个 MCP 工具调用本来就走 `AgentApprovalService`（`agent-turn-service.ts:680-694`），粗粒度的模式门什么也没换来。
- **第一步文件**：`src/main/services/extension-host.ts:275-277`（去掉模式门），`src/renderer/src/Settings.tsx:667-674`（插件列表 + 启用调 `authorizePluginUse`，`register-ipc.ts:1096` 已经接好）。

### 2.5 让 AGENTS.md 被读回 —— 工作量：中
- **我们现在**：`project-init-service.ts:162` 写 `AGENTS.md`，全仓 grep 只有写入路径、命令描述和 UI 标签（已验证），没有任何读回进模型输入的地方。项目级指令的唯一替代是全局 2000 字设置框（`App.tsx:3113`），跨所有工作区共用。
- **他们**：Gemini CLI 从四个来源发现 GEMINI.md、从每个工作区根向上走到 git root、按 (dev,ino) 去重、随导航 JIT 加载；Codex 把 `# AGENTS.md instructions for <path>` 包进 `<INSTRUCTIONS>` 且深层优先；OpenCode 自动加载 AGENTS.md / CLAUDE.md / CONTEXT.md。
- **用户得到**：我们自己宣传的命令生成的文件当前完全无效——这是无声失败，UI 还预览过它。做完之后"别动 src/generated""改完跑 npm run typecheck""这仓库用 pnpm"才真正生效；顺带白拿别人仓库里已有的 AGENTS.md/CLAUDE.md。
- **第一步文件**：`src/main/services/agent-turn-service.ts:1384-1399`（在 instructions 组装处加载并拼入；读取走 `workspace-tool-service` 已有的受限读路径，带大小上限）。

### 2.6 补齐检索三件套：glob / 正则搜索 / 按行读 + 尊重 .gitignore —— 工作量：中 ——【大部分完成 2026-07-27：read_file 行范围 + partial revision、glob 工具（mtime 排序）、search_files regex 开关（线性 NFA 引擎 workspace-pattern-matching.ts，不可 ReDoS）、默认忽略 dist/build/.venv 等目录（显式指定为搜索根仍可进入）。剩余：真 .gitignore 解析】
- **我们现在**：全部工具 9 个；`search_files` schema 自己写着"Regular expressions are not supported"且只匹配内容、无法按文件名找；`read_file` 只有 `relative_path` 一个参数，超过 1MB 直接 `file_too_large` 读不了；`src/main` 里 grep `'glob'` 零命中（已验证）。排除表只有 `PROTECTED_WRITE_DIRECTORY_NAMES`（.git/.codex/.agents/node_modules），`dist`/`build`/`.venv`/`coverage` 全走一遍，而搜索预算只有 2048 文件 / 256 结果。
- **他们**：Gemini CLI 注册 `glob` + `grep_search`（有 ripgrep 用 ripgrep）并带 `respect_git_ignore` 参数；OpenCode 有 `glob`（"任意规模代码库的快速模式匹配"）+ `grep`（内容正则），并把超限工具输出溢写到可再查询的存储；Codex 有增量模糊文件搜索。
- **用户得到**：这是与竞品差距最大的一条。"token 刷新在哪里实现"这种问题，别人 2 次调用命中，我们烧 10 次还可能没找到；package-lock.json、生成的客户端、日志 CSV 完全读不了；900 行文件想看 400-460 行只能整个拉进上下文——这也正是我们刚上线的压缩机制的主要负载来源。搜索预算被 `dist/bundle.js` 吃光后，模型是在拿构建产物推理。
- **第一步文件**：`src/main/services/workspace-tool-broker.ts:160-330`（加 `glob`、给 `search_files` 加 regex 开关、给 `read_file` 加 offset/limit），实现复用 `workspace-tool-service.ts:722-800` 已有的受限遍历器；忽略规则先把渲染层已有的跳过表（`composer-capabilities-adapter.ts:29-33`）搬到主进程，再接真 .gitignore 解析。

### 2.7 写操作前自动检查点 + "撤销这一轮" —— 工作量：中 ——【核心已完成 2026-07-27：agent 回合首个写类工具（write_file/replace_in_file/delete_path/run_command）执行前惰性创建一次检查点（标签"写入前自动检查点"，并发写共享同一 promise，失败不阻塞写入），检查点条可一键回退。剩余：checkpointId 锚定到消息实现精确"撤销这一轮"】
- **我们现在**：`WorkspaceChangeSession` 的快照/回退机制完整（256 检查点 / 512MB 预算 / 冲突检测），但 `agent-turn-service.ts` 和 `workspace-tool-broker.ts` 里 `checkpoint` 零命中——只有用户手点「创建检查点」或 `/checkpoint` 才有。检查点按 id + taskId 索引，没有和消息/轮次绑定。
- **他们**：Gemini CLI 每次编辑前快照到影子 git 仓库，`/restore` 用 `git restore --source` + `git clean -f -d` 同时回退对话和文件，`/rewind` 提供「对话+文件 / 仅对话 / 仅文件」三选；OpenCode 的 revert 锚在 messageID/partID 上，还有暂存式回退。
- **用户得到**：一轮 30 次工具调用跑歪了——12 个文件的错误替换、指错目录的递归删除、覆盖源码的构建——今天不可恢复，除非用户在一个他预期会成功的轮次之前恰好点了检查点，没人这么做。这也是让 `full` 模式敢开着用的前提；没有它，用户要么不用我们最强的功能，要么迟早丢代码。零件全都有，缺的只是触发点和保留策略。
- **第一步文件**：`src/main/services/agent-turn-service.ts`（轮次开始处、首次写类工具前惰性建检查点，把 checkpointId 记到 assistant 消息上），配 `src/main/services/workspace-change-session.ts:244-274`。

### 2.8 压缩阈值改按模型窗口，Chat 也要覆盖，并给出上下文占用条 —— 工作量：中 ——【部分完成 2026-07-27：Chat 回合已纳入轮前自动压缩（turn-admission 经 chat transport 路由，`chatCompactionEndpoint` 映射）。阈值按模型窗口一项经核实无法合规实现：NewAPI 目录与定价接口都不声明上下文窗口，而 AGENTS.md 禁止从模型 ID 猜测；若未来服务端声明有界 `context_window` 字段可再接。上下文占用条（usage.promptTokens 油表化）仍待做】
- **我们现在**：`AUTO_COMPACTION_THRESHOLD_BYTES = 1024*1024*0.9`（已验证），一个全局约 943KB 的字节常量，32k 窗口和 1M 窗口用同一个数；预压缩还被 `turn.mode === 'agent'` 挡住，Chat 完全没有压缩，`chat-turn-service.ts:557` 直接丢最旧消息。UI 上唯一的 token 数字是 `sessionTokens` 累计花费，`/compact` 之后也只增不减。
- **他们**：Gemini CLI 用 `threshold * tokenLimit(model)`（默认 0.5，可按模型覆盖）；Codex 每个模型自带 `auto_compact_token_limit` 与 `effective_context_window_percent`；OpenCode 有完整的会话上下文检查器（限额、各类 token、按角色/工具的占比、解析后的系统提示）。
- **用户得到**：窗口小于约 250k token 的模型（目录里大多数）压缩**永远不会触发**，历史一路涨到被服务端拒绝、或者被字节选择器悄悄截断最早的消息——用户看到的是莫名失败，或者代理"忘了"任务开头的要求，还没有「上下文已压缩」的提示解释。同时那个 token 徽标读起来像账单不像油表，用户无从判断该不该手动压缩。我们的 `usage` 事件本来就带真实 `promptTokens`（`responses-client.ts:1403`），不需要新分词器。
- **第一步文件**：`src/main/services/conversation-compaction-service.ts:25`（阈值改为按确认模型的上下文上限推导），随后 `turn-admission-service.ts:337` 放开 Chat。

### 2.9 给模型一个提问通道（ask_user） —— 工作量：中 ——【已完成 2026-07-27：新 ask_user 工具（question + 2..4 options），复用审批挂起/回填管线（AgentApprovalService.askUser、decision "option:N"、问答与工具审批决策互不可交叉），复用审批模态渲染选项按钮，所有批准模式（含 full）都会真实等待用户；拒答/超时返回指导性失败让模型自行判断。Review 模式不暴露该工具】
- **我们现在**：模型→用户只有审批弹窗一条路，只能回答一个特定本地操作的 allow/deny。歧义时模型只能猜，或者把问题写成最终回复直接结束这一轮，丢掉全部积累的上下文。
- **他们**：Gemini CLI 的 `ask_user` 带 question/header/options/multiSelect，且在 YOLO 模式下仍强制走用户（priority 999）；OpenCode 的 `question` 工具有结构化选项和多问进度；Codex 有 `item/tool/requestUserInput`（含"其他"自由文本、密文字段、自动超时）。
- **用户得到**：歧义是代理工作的常态（哪个配置文件、哪个包管理器、保留还是重写）。今天要么猜错后浪费 15 次工具调用和真实付费额度，要么结束轮次逼用户重发、模型从压缩后的历史重建上下文。审批弹窗已经提供了全部 UI + IPC 基础：轮次内挂起请求 + 渲染层提示 + settle 回调。
- **第一步文件**：`src/main/services/agent-approval-service.ts:228-296`（复用 `#requestUserDecision` 的挂起/回填管线），工具声明加在 `workspace-tool-broker.ts:160`。

### 2.10 重试 / 换模型重答 / 从某条消息分叉 —— 工作量：中 ——【核心已完成 2026-07-27：失败/取消的回合有"重试此轮（当前模型）"按钮；最后一条完成的助手消息有"重新回答"动作（按当前所选模型重发上一条用户消息——先切模型再点即为换模型重答）；任意完成的助手消息可"从此消息创建分支"（fork 带 anchorMessageId，保留到锚点为止的历史、甩掉出错尾巴；锚点必须是 complete 消息）。顺带修复：全量 fork 复制 failed 尾巴时 status 硬编码 idle 会触发文档不变量拒绝保存的存量 bug（改为派生）。剩余：消息级模型选择菜单、用户消息编辑重发】
- **我们现在**：失败的 assistant 消息只渲染一句"本轮未完成，请重试。"，却没有任何重试控件；`MessageActions` 只有复制 + 在新任务中继续 + 模型标签；用户消息无编辑入口；全仓 grep `regenerate|resend|重新回答` 只命中 Studio 的一个 toast。`ConversationHistoryService.fork` 无条件复制全部消息，IPC 契约里没有消息锚点。
- **他们**：Codex 每轮可覆盖 model/effort/sandbox 并有 `thread/rollback`、`thread/fork`；OpenCode 从指定消息 fork 且能 `switchModel`；Gemini CLI 的 `/rewind` 给出带影响预览的消息选择器。
- **用户得到**：这是多模型产品最该有的动作——"同一条提示换个模型再跑一遍并对比"。今天要重打或回忆草稿，带附件的长提示基本做不到；瞬时网络/5xx 失败也得手动重建消息。分叉只能整条复制（连同出错的尾巴），另一条分支永远背着那个错误还每轮为它付费。
- **第一步文件**：`src/renderer/src/App.tsx:1565-1587`（MessageActions 加重试/换模型重答），后端 `src/main/services/conversation-history-service.ts:288-327`（fork 接受消息锚点）。

### 2.11 审批授权要能持久化，并按工作区隔离 —— 工作量：中 ——【已完成 2026-07-27："总是允许"授权现以稳定工作区身份（device:inode）为 v2 scope key，经 DPAPI SecureStore（approval-session-scopes.json）持久化，重启后同工作区静默放行、异工作区仍逐次询问；撤销持久生效；身份无法解析时降级为会话内授权；delete_path 仍永远逐次确认。UI 文案已同步（"本工作区总是允许"）】
- **我们现在**：`#sessionAllowlist` 是纯内存 Map，`dispose()` 里 clear（已验证），重启即失效；作用域 key 只由规范化操作推导，不掺工作区身份——在 A 仓库批准的命令会静默沿用到用户接着打开的 B 仓库。
- **他们**：Codex 在批准时提议一条可读规则并原样落盘（`prefix_rule(pattern=["npm","run","typecheck"], decision="allow")`），可读可 diff 可删，还有 `--ignore-rules`；OpenCode 把"always"写进 sqlite `permission` 表，按 (project_id, action, resource) 索引，可列可逐条撤销。
- **用户得到**：日常就那几个命令（typecheck / test / build / git status），现在每次启动各弹一次——正是这种摩擦把人推向永久开 `full`，把我们设计的分级模型废掉。跨工作区泄漏更危险：在草稿项目批准的 `npm run deploy` 不该带进生产仓库。我们已有 DPAPI 加密存储和白名单审阅/撤销 UI，缺的是一个存储层和一个带工作区的 key。
- **第一步文件**：`src/main/services/agent-approval-service.ts:95`。

### 2.12 把自定义指令/技能文本移出每条用户消息 —— 工作量：中
- **我们现在**：`composer-capabilities.ts:938-951` 把计划标记、上轮摘要、2000 字用户偏好、技能指令、文件提及全部拼进 `transportPrompt`，并原样落进加密历史当作用户消息；`selectModelContext` 每轮重放全部历史消息内容。真正稳定的指令通道 `protocolSessionInstructions()` 反而一个字都没带。
- **他们**：Gemini CLI 把指令上下文一次性拼进系统上下文；Codex 用固定的少量标签块；OpenCode 明确把首块之后的所有系统块合并成一块，就是为了保住可缓存的稳定前缀。
- **用户得到**：满额 2000 字设置 + 20 轮任务 = 约 40KB 逐字重复的样板挤在历史里：每轮吃上下文、被压缩器当成对话去总结、破坏服务商的前缀缓存、还会写进工作区导出文件。
- **第一步文件**：`src/renderer/src/composer/composer-capabilities.ts:938-955`（只发可见提示），指令改由 `src/main/services/agent-turn-service.ts:1384` 组装。

### 2.13 小修补合集 —— 工作量：均为小 ——【已完成 2026-07-27：启动时 settleInterruptedStreaming 把孤儿 streaming 结算为 failed（backend-services 启动即触发）；快捷键设置页补全为真实注册表（任务导航/面板布局/输入区三节）；doom-loop 守卫（相同调用+相同输出 3 次后跳过并给指导，6 次触发可续跑交接）】
- **崩溃/退出后残留的转圈消息**：`deriveTaskStatus` 见到尾部 `streaming` 就返回 `running`，启动时没有任何清扫，退出处理也不结算在途轮次，于是永久转圈 + 侧栏假运行徽标，用户无法清除。→ `src/main/services/conversation-history-service.ts:933-951`（启动时把孤儿 streaming 结算为 failed）。
- **快捷键设置页是错的**：`Settings.tsx:645-655` 只列 4 条（Enter/Shift+Enter/Esc/终端 Enter），而 Titlebar 实际注册了 13 个全局快捷键（Ctrl+K、Ctrl+\`、Ctrl+Shift+F 等），帮助入口和 Ctrl+Shift+/ 都指向这一页。我们做了功能却让用户发现不了。→ `src/renderer/src/Settings.tsx:645-655`（先把真实列表补全，重绑定可以后做）。
- **重复调用守卫（doom loop）**：交互轮次是 `while (true)` 且无预算时无上限，没有相同参数重复调用的检测。`full` 模式下没有审批弹窗做天然中断，循环会一直烧到用户发现。做成一条新的审批理由即可复用现有弹窗。→ `src/main/services/agent-turn-service.ts:536`。

---

## 3. 值得做（高价值，工作量大）

### 3.1 run_command 支持后台进程、流式输出与 stdin —— 工作量：大
- **我们现在**：`runBoundedProcessCore` 把 stdout/stderr 攒进数组，进程退出才 resolve；默认 120 秒超时，超时杀树并**丢弃**缓冲输出；没有 `is_background`、没有进程注册表、没有 stdin。我们刚上线的真 PTY `TerminalService` 只服务渲染层，没有任何代理侧绑定。
- **他们**：Gemini CLI 的 shell 工具带 `is_background`/`delay_ms` 加 `list_background_processes`/`read_background_output`；Codex 有完整进程注册表（流式增量、resize、writeStdin、信号、跨轮次存活的后台终端）；OpenCode 的 bash 是持久 shell 会话。
- **为什么值得**：三类日常流程今天直接不可能——启动 dev server 后验证页面、跑超过两分钟的构建/测试/`npm install`、以及任何会提示 y/N 或要凭据的命令（提示文本被困在被丢弃的缓冲里，人和模型都看不到）。这决定了代理能完成的任务规模上限。而且 PTY 已经写好了，主要是加一层代理可见的进程注册表和工具契约。
- **第一步文件**：`src/main/services/terminal-service.ts:34-140`（抽出与渲染层无关的进程注册表），再在 `workspace-tool-broker.ts:256-281` 扩 schema。

### 3.2 解除"一轮进行中整个应用冻结" —— 工作量：大
- **我们现在**：`interactionBusy = running || composer.submitting || workspaceSwitching` 同时锁住 selectTask / newTask / changeMode / openBackgroundTask / Studio 导航；唯一出口是 Agent 专有的「继续在后台」，而 `#detachTurn()` 会清空会话视图——你会失去刚分离那份工作的实时视图。Chat 完全没有出口。注意主进程的 `agentTurnRegistry`/`chatTurnRegistry` 本来就按 task 键控，这是渲染层的单会话限制，不是后端限制。
- **他们**：Codex 线程是一等对象（start/resume/fork/rollback + 带 `expectedTurnId` 的 `turn/steer`）；OpenCode 每会话独立事件流加 sync/replay/steal；Gemini CLI 有 `/tasks`。
- **为什么值得**：真实 Agent 任务动辄数分钟，这段时间用户不能查另一个会话、不能起第二件事、连 Studio 都进不去。这是"能并肩工作的助手"和"只能干等的助手"的分界；后端已经支持，属于渲染层的状态模型重构。
- **第一步文件**：`src/renderer/src/conversation/conversation-session.ts:1378`（把 running 从全局态改为 per-task），再拆 `App.tsx:3132` 的 interactionBusy。

### 3.3 项目级设置层 + 浅色主题 —— 工作量：中到大
- **我们现在**：`SettingsPreferences` 是渲染层 localStorage 里的一个扁平全局对象（自定义指令、回答语言、shell、git base、worktree 模式…），主进程/共享契约里没有任何 project/workspace 作用域；主题下拉只有 `glass-dark` 一项且 `disabled`，不响应系统 `prefers-color-scheme`。
- **他们**：Gemini CLI 五层作用域合并（System > Admin > User > Workspace > worktree）；Codex 有 `[projects.'<path>']` 块；OpenCode 全局 + 项目双份 `opencode.json`。主题方面 Gemini 有 17 套 + 自动切换，OpenCode 用 VS Code 兼容色令牌。
- **为什么值得**：同时开 Python 服务、TS monorepo 和文档仓库的用户，需要三套 shell / 指令 / worktree 策略；今天切工作区会静默沿用错的设置，"用 pnpm 别用 npm"还会漏进无关项目。另外 localStorage 不随加密历史迁移，换机全丢。浅色主题则是全天面对屏幕的可访问性问题，而且 `tokens.css` 已经是唯一调色板归属，机制已就位。
- **第一步文件**：`src/renderer/src/Settings.tsx:89-128`（把偏好存储搬到主进程并加工作区作用域），主题在 `src/renderer/src/styles/tokens.css`。

### 3.4 统一的 web_fetch / web_search —— 工作量：中
- **我们现在**：`AGENT_TOOLS` 里没有任何 web 工具；唯一的联网能力是 OpenAI Responses 传输层的 `{ type: 'web_search' }` 标志，Chat Completions / Anthropic / Gemini 路线完全没有。BrowserControlService 带着一份完整的私网 SSRF 拒绝表挂在 IPC 上，但渲染层无人调用、模型也拿不到。
- **他们**：Gemini CLI 的 `web_fetch`（含 PrivateIpError 防护、60s/300s 超时）+ `google_web_search`（引用编织）；OpenCode 的 webfetch/websearch 各自受权限门控；Codex 一整套浏览器插件。
- **为什么值得**：对多模型产品来说这是用户直接能感知的路由不一致——同一个问题在 Responses 模型能查网，在 Gemini/Claude 不能，且没有任何解释。具体代价是升级依赖前读不了 changelog、打不开堆栈对应的 GitHub issue、查不了当前 API 文档，于是从训练数据里编 API 形状——这正是用户会怪到我们头上的失败模式。我们需要的 SSRF 防护就在两个文件外闲置着。
- **第一步文件**：`src/main/ipc/register-ipc.ts:1925-1940`（复用私网拒绝表），工具声明加在 `workspace-tool-broker.ts:160`。

### 3.5 自定义斜杠命令 / 提示模板 + 模型自主激活技能 —— 工作量：中
- **我们现在**：`BUILTIN_COMMANDS` 是冻结的 9 条，capability discover 只接受 `'skills' | 'plugins'`，没有命令发现路径。技能只能靠用户先打 `$` 手动选，模型看不到技能索引、也没有 `activate_skill` 之类的工具。
- **他们**：Gemini CLI 从 `**/*.toml` 加载命令（支持 `{{args}}` 和 `!{shell}` 注入）+ `activate_skill`（参数是当前可用技能名的枚举）；OpenCode 有 `command.<name>` 配置和 `skill` 工具；Codex 把 188 个技能压成带 r0/r1 根别名的索引注入。
- **为什么值得**：重复工作流（"按我们的规范审这个 diff""为暂存改动写 conventional commit"）现在只能每次重打。技能这边更亏——装了十个技能，正常使用中一个都不会触发，SKILL.md 格式的核心价值（模型按描述自选）完全没兑现。
- **第一步文件**：`src/main/services/capability-registry.ts:58-149`（命令发现），技能索引注入在 `agent-turn-service.ts:1384`。

### 3.6 会话导出 + 全局搜索带片段与跳转 —— 工作量：中
- **我们现在**：IPC 里根本没有 export 通道；唯一的真实导出是 `ConversationWorkspaceExportService` 自动写进 Agent 工作区的 `AI-TERMINAL-HISTORY-<uuid>.md`，是 Codex 互操作桥、用户不可调用、Chat 完全没有。`conversation:search` 只返回 `TaskSummary[]`，丢掉了命中的是哪条消息，渲染层只拿它过滤侧栏；会话内也没有 Ctrl+F。
- **他们**：Gemini `/export-session` + `/chat share`；OpenCode `export`/`import` + 会话内搜索；Codex 的 rollout JSONL 本来就是可复制的纯文本。
- **为什么值得**：转录常常本身就是交付物（贴进工单的调试记录、给同事的架构讨论）。我们乐于导入 Codex/Claude/Gemini/Grok 的历史却不给自己的出口，这在锁定感上是个坏信号——而且我们已经有能正确做这件事的脱敏管线。搜索则是"技术上能用、实际上没法用"：过滤出一个几百条消息的任务后，既不自动滚动又没有页内查找。
- **第一步文件**：`src/shared/ipc-channels.ts:11-20`（加 export 通道，复用 `conversation-workspace-export-service.ts` 的脱敏），搜索片段在 `src/main/services/conversation-history-service.ts:329-340`。

### 3.7 有条件推进：远程 MCP OAuth、Windows 沙箱
- **MCP OAuth**（大）：`McpSession` 只有 listTools/callTool/close，HTTP 授权头只能展开 `${ENV_VAR}`，没有授权码流、令牌存储、刷新，也没有 resources/prompts。所有值得用的托管连接器（GitHub、Linear、Sentry、Notion）都走 OAuth，用户现在只能把长期 PAT 明文写进 `.mcp.json`——而那个文件就在代理自己能读的目录里。**做的前提是 2.4 先落地**，否则没人能连 MCP。第一步：`src/main/services/mcp-client.ts:89-120`。
- **Windows 受限令牌沙箱**（很大）：我们的防线全在进程启动前（argv 数组、shell:false、环境清洗、超时、杀树），spawn 之后子进程继承完整用户令牌。Codex 为每个工作目录铸一个 AppContainer capability SID，还跑后台审计给全局可写路径打 deny ACE。现实风险不是模型作恶而是供应链：用户批准了确实想跑的 `npm install`，某个包的 postinstall 就以用户全权运行。**建议只在决定长期押注 `auto` 模式自动放行命令时才启动这个工程**；在那之前，2.7 的自动检查点覆盖了大部分实际损失。第一步：`src/main/services/workspace-tool-service.ts:2860-2900`。

---

## 4. 可以不做

- **CONSECA 式每轮 LLM 生成最小权限策略**（Gemini）：每轮多一次 flash 调用的延迟和成本，换来的是不可预测的权限决策。我们的卖点恰恰是审批可预测、可预览、可审计，方向相反。
- **Guardian 式 LLM 审批代理**（Codex）：同上。桌面场景用户就在屏幕前，把审批交给另一个模型是在解决 CI 无人值守的问题，不是我们的问题。
- **Code mode（单 `exec` 工具 + V8 隔离区里写 JS）**（Codex）：与我们的 argv 白名单 + 命令预览 + 逐操作路径分类彻底冲突——审批弹窗将无法展示"到底会发生什么"。而且要额外维护一个 JS 运行时的安全边界。
- **浏览器代理 / 计算机使用**（Codex）：工程量巨大，且与"工作区绑定的编码代理"定位不符。BrowserControlService 保持现状（渲染层可用、不给模型）是对的。
- **自动记忆挖掘流水线**（Codex 两阶段 + Gemini `/memory inbox`）：诚实排序——先做 2.5（读 AGENTS.md），用户手写就能拿到八成价值。自动抽取 + 审阅队列是后续大工程，现在做是错的优先级。
- **ACP / headless server / 远程配对 / mDNS**（三家都有）：那是 CLI 优先产品把 GUI 当客户端的架构选择。我们是桌面应用，把核心改成网络可寻址的服务器是全面重构，换来的用户价值在我们的场景里接近零。
- **18 语言本地化、语音输入、实时语音会话**：中文 UI 是我们的定位优势，多语言现在没有需求；语音是完全独立的产品方向。
- **TOML 声明式策略引擎 + 优先级分层**（Gemini）：思想很好，但我们的 `AgentApprovalService` 已经覆盖了实际需求；序列化策略层的收益要到"企业管理员集中下发策略"时才兑现，那不是现阶段的用户。
- **影子 git 仓库做快照**：我们的 `WorkspaceChangeSession` + worktree 已经解决了同一个问题，且 hunk 级审阅比他们更细。2.7 只需接上触发点，不要换实现。

---

## 5. 我们已经领先的地方（别动）

- **三面一体的桌面产品**：Chat / Agent / Studio 在一个应用里，Studio 的节点图 + 任务队列 + 运行记录三家竞品都没有对应物。
- **审批体验**：逐操作路径分类（read/write/delete/command 各自判定）+ 命令与 diff 预览 + 会话白名单的审阅/撤销 UI。竞品要么只有粗粒度模式（Gemini 四档），要么把可读性交给规则文件（Codex）。
- **变更审阅**：`ChangeReviewCenter` 的 hunk 级 revert + 文件级回滚 + worktree apply/discard，比 OpenCode 的 messageID 级 revert 更细，比 Gemini 的整仓 restore 更精确。
- **git worktree 隔离**：作为一等的任务隔离机制，Gemini 还藏在 `experimental.worktrees` 后面。
- **加密历史与互操作**：DPAPI 加密存储 + 导入 Codex/Claude/Gemini/Grok 历史，这是获客路径，竞品只有 Codex 有对应能力。
- **刚发的六条**：真 PTY 终端、执行预算、模型驱动压缩（手动 + 轮前自动）、上下文相关审批、Composer 的历史召回/自动增高/队列消息/@提及/拖拽、逐消息模型归属、供应商历史归档移除、gitBase diff 基线、自定义指令与回答语言注入。这些不需要再补，本报告的建议是围绕它们的缺口（例如压缩阈值、@提及索引、PTY 的代理侧绑定）。
- **计划模式的写入限制**：思路与 Gemini 的 plan.toml 一致且已落地，不需要改。