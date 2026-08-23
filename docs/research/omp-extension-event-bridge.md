# OMP Extension 事件桥接能力研究

> 证据截止：2026-08-23。OMP 源码 `/Users/bytedance/Developer/oh-my-pi` @ `160ed439ac`（version 18.0.3，见 `packages/coding-agent/CHANGELOG.md` 与 `package.json`）；bridge 源码 `/Users/bytedance/Developer/lark-bot-bridge` @ `5e73c32`。仅用项目本地源码与第一方文档（`docs/rpc.md`、`docs/extensions.md`、`docs/extension-loading.md`、`python/omp-rpc`）。未启动任何程序、未修改生产代码。行号以取证时的工作树为准。

## 0. 结论先行

**问题**：只新增一个受信 OMP extension，能否通过官方支持、可结构化、可鉴权的通道，向 lark-bot-bridge 输出当前 RPC 未提供的"安全 Progress 与运行统计"，从而简化当前 OMP-only 统一 Reply 设计？

**答案：否。** 三个独立事实叠加后结论不可逆：

1. **RPC 已经转发绝大多数"运行统计"**。`omp --mode rpc` 的 stdout 事件流转发全部 `AgentSessionEvent`（`docs/rpc.md` §Event Stream Schema；`rpc-mode.ts` `session.subscribe(event => output(event))`），其中包括：`auto_retry_start/end`（attempt/maxAttempts/delayMs/errorMessage/finalError）、`retry_fallback_applied/succeeded`（from/to/role/model）、`auto_compaction_start/end`、`notice`、`thinking_level_changed`、`goal_updated`、`todo_reminder`、`model_changed`、`ttsr_triggered`、`turn_start/end`、`tool_execution_start.intent`、`message_end.message.usage/duration/ttft/timestamp/stopReason/provider/model`、`get_state.contextUsage`、`get_session_stats`（token 全量 + cost + 计数）、`extension_error`。lark-bot-bridge 的 `OmpRpcTranslator` 只翻译了 12 个 frame 类型（`rpc.ts:88-220`），**其余 20+ 个已在 RPC 线上的事件类型被直接丢弃**。也就是说："RPC 未提供的 Progress 与运行统计"这一前提大部分不成立——字段在线上，只是 bridge 没消费。
2. **extension→RPC host 不存在任意结构化数据通道**。官方通道只有 `extension_ui_request` / `extension_ui_response` 一对（`rpc-types.ts:375-433/547-550`）：5 个请求-响应对话框（select/confirm/input/editor/cancel）+ 5 个 fire-and-forget UI 原语（notify/setStatus/setWidget/setTitle/set_editor_text）+ OAuth `open_url`。fire-and-forget 无 ack、无次序承诺之外的递送保证；`ctx.ui.setStatus/notify/widget` 是**显示协议，不是遥测协议**，不存在把结构化事件传给 host 的官方方式。extension 与其宿主之间也没有任何鉴权握手——信任只由 spawn 时的 `--trusted-extension` 路径白名单建立。
3. **三种候选方案都不删除 bridge 代码**。extension-only 与"借用 UI 协议"方案净增 bridge 代码（新的解析/模式/对账路径），同时引入同进程信任面；OMP 核心 RPC 增加结构化 custom-event 是唯一能"锁定 Progress/RunMetrics 字段"的方案，但短期也是纯新增。**真正的净删减量为零、复杂度为负的路径是：纯 bridge 侧翻译已经在 RPC 线上的事件**（零 OMP 改动、零 extension、零新信任面）。

**最小建议**（按实施顺序）：

- **Phase 1（推荐，无需任何 OMP 改动）**：在 bridge 的 `OmpRpcTranslator` 中翻译已上线的事件——`auto_retry_start/end`、`retry_fallback_applied/succeeded`、`notice`、`tool_execution_start.intent`、`message_end.message` 的 `duration/ttft/stopReason/provider/model`、`usage` 全量（cacheWrite/totalTokens/premiumRequests），并定期 `get_session_stats` 汇总 cost/tokens。这直接给 Progress Reply 补充"重试中/第 N 次尝试/fallback 到 X/耗时/吞吐"内容，字段全部有官方 schema（`AgentSessionEvent` 联合类型），不新增任何信任面。
- **Phase 2（可选，仅在需要 provider 级元数据时）**：向 OMP 上游提交 RPC 协议扩展——新增一个结构化事件 frame（如 `{ type: "custom_event"; payload: unknown }`）或专门的 `progress`/`run_metrics` frame，纳入 `RpcCommand`/`AgentSessionEvent` 联合类型并写 `docs/rpc.md`，经既有 protocol v2 协商上线。这是唯一能"锁定字段"的方案（`rpc-types.ts` 联合类型即 wire contract），代价是依赖 OMP 版本升级。
- **不建议**：extension-only 或借用 UI 协议。extension 同进程、无沙箱（`docs/extension-loading.md` "Extensions are not sandboxed"）、无版本固定、加载失败静默降级（`loader.ts:455-481` per-path 错误非致命；`main.ts:1828-1831` 仅启动告警），且 `--trusted-extension` 会**关闭所有环境扩展发现**（`main.ts:1292-1319`），与用户自身 `.omp/extensions` 冲突。

## 1. 方法与证据边界

- 只读一手来源：OMP 本地源码（`packages/coding-agent`、`packages/agent`、`packages/ai`）与第一方文档（`docs/rpc.md`、`docs/extensions.md`、`docs/extension-loading.md`、`python/omp-rpc/README.md`、`CHANGELOG.md`）。
- bridge 侧读 `src/agent/omp/adapter.ts`、`src/agent/omp/rpc.ts`、`src/agent/types.ts`、`src/card/run-state.ts`、`src/bot/channel.ts`、`src/agent/capability.ts`。
- 不启动 OMP、不跑测试、不运行 formatter/linter；所有"RPC 已转发"结论由代码路径（`#emitSessionEvent` → `#emit` → `session.subscribe` → `output`）与 `docs/rpc.md` 事件清单双重验证。
- 不声称穷尽；extension 可见字段以 `ExtensionAPI.on()` 可订阅事件联合（`extensions/types.ts:1255-1278`）为准。

## 2. bridge 现状：OMP RPC 管线消费了什么

`OmpAdapter.start` 以如下参数 spawn OMP（`adapter.ts:253-271`）：

```
omp --mode rpc --no-title --approval-mode yolo --append-system-prompt <tmpfile> [--profile] [--resume] [--model]
```

- `--no-title` 与 RPC 模式都设置 `PI_NO_TITLE=1`（`main.ts:1467-1474`），避免标题模型额外调用。
- 事件流经 `OmpRpcTranslator.translate`（`rpc.ts:88-220`）翻译为 `AgentEvent`（`agent/types.ts`），再经 `RunState` reducer（`card/run-state.ts:43+`）折叠成统一 Reply 卡片（text 块 / tool 块 / footer / terminal）。
- **翻译器处理**：`response`（negotiate_protocol / get_state / prompt）、`message_start`、`message_update`（text_delta / thinking_delta）、`message_end`（文本 + usage 的 6 个数字字段）、`tool_execution_start`、`tool_execution_end`、`command_output`、`prompt_result`（agentInvoked=false）、`agent_end`（usage + terminal）。
- **`extension_ui_request` 处理**：仅对 select/confirm/input/editor/open_url 回复 `extension_ui_response { cancelled: true }`（`adapter.ts:333-348`）；notify/setStatus/setWidget/setTitle/set_editor_text 落入 `translate` 后被忽略。

## 3. 已在线、但 bridge 未翻译的事件（免费午餐）

以下 frame 类型由 RPC 模式原样转发（`rpc-mode.ts:978-980`；`agent-session-events.ts:12-66`；`docs/rpc.md:459-516`），bridge 翻译器对它们**零输出**（`rpc.ts:88-220` 无对应分支）。

| 事件 / 字段 | 官方 schema 位置 | 对 Progress Reply 的价值 |
|---|---|---|
| `auto_retry_start` {attempt, maxAttempts, delayMs, errorMessage, errorId?} | `shared-events.ts:243-250` | "第 N/M 次重试，delayMs" |
| `auto_retry_end` {success, attempt, finalError?, retryErrors?} | `shared-events.ts:261-267` | 重试收尾/失败原因 |
| `retry_fallback_applied` {from, to, role} / `retry_fallback_succeeded` {model, role} | `shared-events.ts:270-282` | "降级到 model" |
| `auto_compaction_start/end` {reason, action, result, aborted, willRetry} | `agent-session-events.ts:22-40` | 上下文压缩中 |
| `notice` {level, message, source} | `agent-session-events.ts:56-58` | 运行提示（OMP 侧） |
| `thinking_level_changed`、`goal_updated`、`todo_reminder`、`model_changed`、`ttsr_triggered` | `agent-session-events.ts:50-66` | 状态角标 |
| `turn_start` / `turn_end` | `packages/agent/src/types.ts:874-884`（核心裸事件）；带 turnIndex/timestamp 的变体为 extension-only | 轮次计数（RPC 侧为裸事件，无 timestamp） |
| `tool_execution_start.intent`（模型自述意图，`tools.intentTracing` 默认开启） | `packages/agent/src/types.ts:883`；`settings-schema.ts:4533-4535`；`sdk.ts:3388` | tool 块显示"意图" |
| `message_end.message.usage` 全量（input/output/cacheRead/**cacheWrite**/reasoningTokens/**totalTokens**/premiumRequests + cost） | `packages/ai/src/types.ts:899-979` | 运行统计（bridge 现只取 6 个字段，`rpc.ts:253-270`） |
| `message_end.message.duration` / `ttft` / `timestamp` / `stopReason` / `provider` / `model` / `upstreamProvider` / `errorStatus` / `errorId` / `contextSnapshot` | `packages/ai/src/types.ts:899-979` | 耗时、首字延迟、停因、成本归属 |
| `agent_end.messages`（整轮完整消息数组） | `docs/rpc.md:502-515` | 终态审计 |
| `get_state.contextUsage` {tokens, contextWindow, percent} | `rpc-types.ts:99-122` | 上下文占用百分比 |
| `get_session_stats` → SessionStats {userMessages, assistantMessages, toolCalls, toolResults, tokens{input,output,reasoning,cacheRead,cacheWrite,total}, premiumRequests, cost, contextUsage} | `agent-session-types.ts:387-406`；命令见 `rpc-types.ts` | 运行统计聚合（需 host 主动拉取） |
| `extension_error` {extensionPath, event, error} | `rpc-mode.ts:965-967`；`docs/rpc.md:489-495` | 扩展失败可见性 |
| `subagent_lifecycle` / `subagent_progress` / `subagent_event`（`set_subagent_subscription` 订阅） | `rpc-types.ts:344-372`；`docs/rpc.md:529-548` | 子代理进度 |

> 注意：`agent_end` 上的 `telemetry`/`coverage`（`AgentRunSummary`：per-tool 延迟/ok/error/blocked/timeout/aborted、chat 延迟、usage 汇总、cost、stepCount，`run-collector.ts:68-106`）**默认不在线上**——只有配置了 OTEL 端点环境变量才启用（`main.ts:1756-1759`；`sdk.ts:3394`；`telemetry-export.ts:45-46`）。bridge 当前不设置这些环境变量。这是"RPC 未提供"的真实子集之一，但属"未开启"而非"协议缺失"。

## 4. Extension 独有、RPC 未转发的字段（genuinely new）

以下事件只走 `ExtensionRunner`（`runner.ts:1654-1693`、`agent-session.ts:3440-3500` 等），**不在** `AgentSessionEvent` 联合（`agent-session-events.ts:12-66`），因此 RPC 不转发；extension 是观察它们的唯一官方途径（`ExtensionAPI.on()` 订阅面，`extensions/types.ts:1255-1278`）：

| 事件 | 载荷 | 位置 | 对 Progress/RunMetrics 的价值 |
|---|---|---|---|
| `before_provider_request` | payload（可替换请求体） | `extensions/types.ts:731-734`；`runner.ts:1654-1668` | 低（请求体审计） |
| `after_provider_response` | {status, headers, requestId, metadata?} | `extensions/types.ts:736-739`；`runner.ts:1683-1693`；`packages/ai/src/types.ts:336-341` | 中（HTTP 状态、requestId；duration 已在 message 上） |
| `tool_call` / `tool_result` | 带类型化 details：BashToolDetails{timeoutSeconds, requestedTimeoutSeconds, meta}、EditToolDetails、ReadToolDetails{kind, truncation, isDirectory}、Grep/GlobToolDetails{truncation, limit} | `extensions/types.ts:916-1010`；`tools/bash.ts:345+` 等 | 低-中（截断/超时信息；延迟统计只在 OTEL 汇总里） |
| `tool_approval_requested` / `tool_approval_resolved` | sessionId, toolCallId, policy 等 | `extensions/types.ts:898-913`（wrapper.ts 仅在注册了 approval handler 时发出） | 低（bridge 用 yolo 模式） |
| `context` | 将发往 LLM 的消息深拷贝 | `shared-events.ts:179-186` | 中（精确上下文窗口内容；`get_state.contextUsage` 只有汇总） |
| session 生命周期：`session_start`、`session_before_switch/switch`、`before_branch/branch`、`before_compact/compacting/compact`、`before_tree/tree`、`shutdown` | 分支/压缩条目、信号 | `shared-events.ts:27-172` | 低（bridge 单会话单进程） |
| `input` / `user_bash` / `user_python` | 用户输入/命令 | `extensions/types.ts:857-895` | 低 |
| `credential_disabled`、`mcp_notification`、`resources_discover` | provider/服务通知 | `extensions/types.ts:818-855` | 低 |
| `TurnStartEvent`/`TurnEndEvent` 的 turnIndex+timestamp 变体 | （RPC 侧为裸事件） | `shared-events.ts:207-214` | 低（timestamp 可从 message.timestamp 推导） |

**净评估**：这些字段中没有一个是 Progress Reply 卡片当前需要的；最接近的 `after_provider_response.status/requestId` 与 `context` 也属于诊断层，而非用户可见 Progress。

## 5. Extension → RPC host 的官方通道与语义

### 5.1 通道清单（`rpc-types.ts:375-433`；实现 `rpc-mode.ts:771-956`）

| 通道 | 方向 | 语义 | 安全/递送 |
|---|---|---|---|
| `extension_ui_request` select/confirm/input/editor + `extension_ui_response` {value/confirmed/cancelled} | 请求-响应 | 对话框；`cancel` 可撤销未决请求 | 无鉴权字段；host 可任意 cancel；timeout 可选 |
| `extension_ui_request` notify / setStatus{statusKey,statusText} / setWidget{widgetKey,widgetLines,placement} / set_editor_text / setTitle（`PI_RPC_EMIT_TITLE=1` 才发） | fire-and-forget | 显示原语 | **无 ack、无回执、无重试**；RPC 实现里 setWidget 只支持 string[]（factory 忽略，`rpc-mode.ts:849-862`）；setTitle 默认关闭（`rpc-mode.ts:872-881`；`shouldEmitRpcTitles` `rpc-mode.ts:534-541`） |
| `extension_ui_request` open_url {url, launchUrl?, instructions?} | fire-and-forget | OAuth 打开 URL | bridge 当前取消它 |
| `extension_error` | 服务器→host | 扩展运行时错误 | 已在线，bridge 忽略 |
| （非官方）`pi.appendEntry(customType, data)` | 进程内持久化 | 写入 session 文件 custom entry | 非实时通道；host 只能经 `get_messages`/会话文件间接读 |
| （非官方）`pi.sendUserMessage/sendMessage` | 进程内注入 | 向 agent 循环注入消息 | 危险：会驱动 agent 行动，不是数据通道 |

**不存在**：任意 extension 事件输出（无 `custom_event`/`extension_event`/`emit` 类 frame）；无 extension→host 的命名管道/socket API；extension 的 stdout 就是 OMP 的 RPC stdout，extension 直接写 stdout 会破坏 JSONL 协议流。

### 5.2 `ctx.ui.setStatus/notify/widget` 不是遥测协议

- 载荷形态：setStatus 是 `(key, text|undefined)` 单个字符串；setWidget 是 `(key, string[]|undefined, placement)`；notify 是 `(message, type)`（`extensions/types.ts:278-291`）。全是**显示层**内容，RPC 侧转发为 UI frame 的唯一用途是"host 可以呈现它们"（`docs/extensions.md` §RPC mode："`ctx.ui` is backed by RPC `extension_ui_request` events"）。
- 无 schema、无版本、无 ack；`setStatus` 的 key 是自由字符串，同一 key 后写覆盖前写，无递送保证。把 JSON 塞进 `statusText`/`widgetLines` 是可工作的 hack，但协议本身不承诺结构化、不承诺送达、不承诺顺序（只有 stdout JSONL 的物理次序），任何 bridge 侧的解析都是对显示原语的逆向工程——**本报告不把该用法表述为正式遥测协议**。

## 6. 加载 / 隔离 / 信任边界

### 6.1 发现（`docs/extension-loading.md:26-110`）

- 项目级：`<cwd>/.omp/extensions`（仅 cwd，**不向上走祖先目录**）；用户级：`~/.omp/agent/extensions`（`--profile <name>` 时为 `~/.omp/profiles/<name>/agent/extensions`，受 `PI_CODING_AGENT_DIR` 影响）；settings.json#extensions；已装插件的 `omp.extensions` manifest；CLI `-e/--extension`、`--hook`；config.yml `extensions:`。
- `--no-extensions` → `disableExtensionDiscovery=true`：仅禁环境发现，显式 `-e/--hook` 仍加载（`main.ts:1317-1319`；`docs/extension-loading.md:97-110`）。

### 6.2 `--trusted-extension`（精确白名单，`main.ts:1292-1319`；`args.ts:314-330`）

- 语法：可重复、**必须是绝对路径**；realpath + stat，必须是存在的文件（非目录），否则启动报错。
- 语义：`disableExtensionDiscovery=true`（关闭所有环境扩展发现）+ `additionalExtensionPaths = trustedPaths`——**受信扩展模式下，用户自己的环境扩展也不加载**。
- 互斥：不可与 `--extension`/`-e`/`--hook` 组合（`args.ts:320-322`）。
- RPC 模式同样走 `buildSessionOptions`，因此 `omp --mode rpc --trusted-extension <abs>` 合法。

### 6.3 隔离与失败边界（`docs/extension-loading.md:237-253`；`loader.ts:455-481`；`main.ts:1828-1831`）

- **无沙箱**：extension 与 OMP 同进程、共享 EventBus/ExtensionRuntime；加载期调用 runtime action 抛 `ExtensionRuntimeNotInitializedError`。
- 加载失败：per-path 捕获，**不中断**其他扩展与整个会话；主路径只打印启动告警（`formatExtensionLoadNotifications`）。受信扩展加载失败 = **静默降级**（OMP 照常运行、无该扩展），bridge 若依赖它必须自行监听 `extension_error` 或协商就绪标记。
- 运行时失败：handler 异常被 runner 捕获为 `extension_error`；但裸 `setInterval`/detached promise 抛错是**进程级 fatal**（`docs/extensions.md` §Background work）——信任扩展写坏一个 timer 会杀掉整个 OMP 会话。
- **版本固定：无**。路径式模块加载 + `?mtime` cache-buster（`docs/extension-loading.md:226-232`）；无签名、无版本清单、无来源校验。`--trusted-extension` 的"信任"= spawn 时桥接器选择的绝对路径，运行期无任何再校验。
- 项目信任：`ctx.isProjectTrusted()` 恒真——`.omp/extensions` 等项目输入**无条件加载**（`extensions/types.ts:539-547`）。冒充边界：任何能向该目录写入的人即可注入代码；bridge 的 run cwd 是策略选定的工作目录（`run-flow.ts` `resolveWorkingDirectory`），其 `.omp/` 内容在受信扩展方案里仍会被发现（除非用 `--trusted-extension` 关闭发现——但那也会关掉用户扩展）。

### 6.4 RPC 模式下的 extension 行为（`rpc-mode.ts:956-975`）

- RPC 模式**加载扩展**（与模式无关，走 `createAgentSession`）；`initializeExtensions(session, { mode: "rpc", uiContext: rpcUiContext })`；`ctx.mode === "rpc"`；`setToolUIContext(rpcUiContext, true)` → hasUI=true。
- `ctx.ui` 的 RPC 实现如上（5.1）；交互式专属方法（onTerminalInput/custom/setFooter/setHeader/setEditorComponent/addAutocompleteProvider/setWorkingMessage/主题）为 no-op（`docs/extensions.md` §RPC mode）。

## 7. 三方案对比矩阵

| 维度 | A. extension-only | B. 借用 UI 请求侧信道 | C. OMP 核心 RPC custom-event |
|---|---|---|---|
| 机制 | bridge 以 `--trusted-extension <abs>` spawn；extension 订阅事件后**必须借用 UI frame 或旁路文件**输出（无官方数据通道） | extension 调 `ctx.ui.setStatus/setWidget/notify` 传 JSON；rpc-mode 今天就把它们转发为 `extension_ui_request`，bridge 已解码但丢弃 | OMP 上游新增结构化 frame（如 `custom_event`/`progress`/`run_metrics`）进 `RpcCommand`/`AgentSessionEvent` 联合，写 `docs/rpc.md`，经 protocol v2 协商 |
| bridge 删除的代码 | **0 行**（翻译器原样保留） | **0 行** | **0 行**（纯新增 frame 翻译；若 OMP 提供专门 progress 帧，可替换部分 message 启发式——属推测） |
| bridge 新增代码 | extension 模块（≥100 行）+ 旁路解析/对账（~100 行） | ~60-120 行解析 + payload schema + 排序/去重 | ~60-150 行翻译器分支 + frame 类型；OMP 侧 frame 类型/发射/文档/测试 |
| 部署面 | 扩展文件随 bridge 分发；spawn 参数 +1；**关闭用户环境扩展** | 同 A（仍需把扩展装进 OMP 发现或 `-e`） | OMP 版本升级依赖（`supportedProtocolVersions` 协商）；bridge 需随版本验证 |
| 信任面 | 同进程全权代码：可读 session/modelRegistry、可发消息、可注册工具（`extensions.md` §Runtime model）；无签名/版本固定；写坏 timer 可杀进程 | 同 A | 无新增进程内代码；协议帧仍无鉴权，但数据来源是核心而非第三方代码 |
| 失败降级 | 扩展加载失败→OMP 静默继续（`loader.ts`）→bridge 无数据→回落现状；bridge 需自建 `extension_error`/就绪监控 | 同 A；帧丢失无 ack 可感知 | 旧版 OMP 无此 frame→bridge 按 `supportedProtocolVersions` 协商回落现状 |
| 字段锁定 | 不可（自由字符串） | 不可（自由字符串） | **可**（联合类型即 wire contract；可带版本） |
| 结构化/可鉴权 | 无通道；仅路径白名单 | 非正式协议，无 ack/无 schema | 官方 frame + schema；鉴权仍是进程边界 |
| 净删减量（对统一 Reply 复杂度） | **负**（净增） | **负**（净增） | **负→零**（短期净增；长期若 progress 帧替代启发式可转正，但不承诺） |
| 与"RPC 原样事件"比较 | 覆盖 §4 的 extension-only 字段（对 Reply 卡片价值低）；§3 的免费午餐不需要它 | 同 A | 可覆盖 §4 字段 + 未来自定义字段 |

## 8. 净删减量量化（相对现状）

- 现状 OMP 管线：`OmpRpcTranslator`（`rpc.ts` ≈340 行）+ `RunState` reducer（`run-state.ts` ≈190 行）+ channel 统一 Reply 流（`channel.ts` 1300+ 行）。三者皆非 extension 可删除的：reducer/channel 与事件来源无关，翻译器若移除则没有任何事件可翻译。
- A/B：新增 >0，删除 0 → **净增加**。C：新增 >0，删除 0（短期）→ 净增加；唯一可能"删除"的场景是 OMP 官方 progress 帧替代 message_update 启发式，无实现承诺。
- **真正净减少方案不在三方案内**：bridge 翻译 §3 已上线事件（~100-200 行），OMP/bridge 的删除量都是 0，但用户可见信息量增加，且零信任面变化。若以"单位复杂度换取的 Progress 信息"衡量，Phase 1 的性价比远超 A/B/C。

## 9. 结论复述

- 单一受信 extension **不能**简化 OMP-only 统一 Reply 设计；它不能删除任何 bridge 复杂度，不能提供结构化可鉴权通道，且 `--trusted-extension` 的副作用（关闭环境扩展、同进程全权、无版本固定、加载失败静默）使其成为三个方案里成本最高、收益最低的一个。
- 真正"genuinely new"的 extension-only 信息是 §4 的 provider 响应元数据/工具 details/审批/上下文快照——对用户可见 Progress 无价值；即便需要，Phase 2 的 OMP 核心 RPC frame 是更干净的正规化路径。
- 立即行动项是 **bridge 侧消费 §3 的免费午餐**；本报告未发现任何必须依赖 extension 才能获得的信息。

## 10. 引用

### OMP（/Users/bytedance/Developer/oh-my-pi @ 160ed439ac, 18.0.3）

- `docs/rpc.md:459-516` — Event Stream Schema：RPC 转发 `AgentSessionEvent` 全清单（含 auto_retry/retry_fallback/notice/thinking_level_changed 等）。
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts:978-980` — `session.subscribe(event => output(event))`：所有 AgentSessionEvent 上 stdout。
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts:960-975` — RPC 模式 `initializeExtensions(session, { mode: "rpc", uiContext })`。
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts:771-956` — RPC ExtensionUIContext 实现（select/confirm/input/editor 往返；notify/setStatus/setWidget/setTitle/set_editor_text fire-and-forget）。
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts:534-541, 872-881` — `PI_RPC_EMIT_TITLE` 默认关闭。
- `packages/coding-agent/src/modes/rpc/rpc-types.ts:375-433` — `RpcExtensionUIRequest` 联合（UI 通道完整清单）。
- `packages/coding-agent/src/modes/rpc/rpc-types.ts:547-550` — `RpcExtensionUIResponse`。
- `packages/coding-agent/src/modes/rpc/rpc-types.ts:99-122` — `RpcSessionState.contextUsage`。
- `packages/coding-agent/src/session/agent-session-events.ts:12-66` — `AgentSessionEvent` 联合（RPC 线上事件全集）。
- `packages/coding-agent/src/session/agent-session-types.ts:387-406` — `SessionStats`（get_session_stats 载荷）。
- `packages/coding-agent/src/session/agent-session.ts:2121-2161` — `#emitSessionEvent`：extension 投递后 `#emit` 到订阅者。
- `packages/coding-agent/src/session/agent-session.ts:3594-3653` — `#emitExtensionEvent`：extension-only 投递（turn 事件带 turnIndex/timestamp）。
- `packages/coding-agent/src/extensibility/shared-events.ts:179-214, 243-282` — ContextEvent / TurnStart/End / AutoRetry / RetryFallback 载荷。
- `packages/coding-agent/src/extensibility/extensions/types.ts:256-371` — `ExtensionUIContext`（setStatus/notify/setWidget 签名）。
- `packages/coding-agent/src/extensibility/extensions/types.ts:455-548` — `ExtensionContext`（mode/hasUI/getContextUsage/isProjectTrusted）。
- `packages/coding-agent/src/extensibility/extensions/types.ts:1255-1278` — `ExtensionAPI.on()` 可订阅事件全集。
- `packages/coding-agent/src/extensibility/extensions/types.ts:731-739` — before/after_provider_request 事件。
- `packages/coding-agent/src/extensibility/extensions/runner.ts:1654-1693` — before/after_provider_request 仅经 extension runner 发射。
- `packages/coding-agent/src/extensibility/extensions/loader.ts:455-481` — per-path 加载错误非致命。
- `packages/coding-agent/src/main.ts:1292-1319` — `--trusted-extension` 精确白名单 + `--no-extensions`。
- `packages/coding-agent/src/main.ts:1828-1831` — 扩展加载错误仅启动告警。
- `packages/coding-agent/src/main.ts:1756-1759` — OTEL 启用才注入 telemetry。
- `packages/coding-agent/src/sdk.ts:3388-3394` — intentTracing/telemetry 装配。
- `packages/coding-agent/src/config/settings-schema.ts:4533-4535` — `tools.intentTracing` 默认 true。
- `packages/agent/src/types.ts:864-884` — 核心 AgentEvent（tool_execution_start.intent）。
- `packages/agent/src/run-collector.ts:68-106` — `AgentRunSummary`（telemetry 汇总，需显式启用）。
- `packages/ai/src/types.ts:336-341, 899-979` — `ProviderResponseMetadata`；`AssistantMessage`（usage/duration/ttft/timestamp/provider/model）。
- `docs/extension-loading.md:26-110, 226-232, 237-253` — 发现/禁用/加载/失败/隔离（"not sandboxed"）。
- `docs/extensions.md` §RPC mode / §Background work / §Runtime model — RPC 下 ctx.ui 行为、timer fatal、注册时序。
- `python/omp-rpc/README.md` §Extension UI Requests — 第一方客户端对 UI 帧的 headless 处理（忽略被动通知、取消对话框）。
- `packages/coding-agent/CHANGELOG.md:696-698` — `--trusted-extension` 引入说明。

### bridge（/Users/bytedance/Developer/lark-bot-bridge @ 5e73c32）

- `src/agent/omp/adapter.ts:253-271` — spawn 参数（`--mode rpc --no-title --approval-mode yolo --append-system-prompt`）。
- `src/agent/omp/adapter.ts:333-348` — extension_ui_request 仅取消对话框类方法。
- `src/agent/omp/rpc.ts:88-220` — 翻译器处理帧清单（12 类）。
- `src/agent/omp/rpc.ts:253-270` — usageEvent 只取 6 个数字字段。
- `src/agent/types.ts:17-33` — bridge `AgentEvent` 联合。
- `src/card/run-state.ts:20-43` — `RunState` 与 reducer 入口。
- `src/bot/channel.ts:1055-1147, 1238-1285` — 懒加载 Progress 流与 `shouldOpenProgressStream`。
