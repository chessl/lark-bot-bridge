# Lark / 飞书 Bot × 可执行 AI Agent：社区与官方实现基线

> 证据截止：2026-08-20。只使用官方文档、项目自身 GitHub 仓库、源码、提交与发布记录。本清单是可复现范围内的基线，不声称绝对穷尽。

## 范围与方法

### 定义与纳入规则

本文研究 **Lark/飞书作为消息入口，后端能运行工具、工作流或可执行 Agent** 的公开实现，而不是所有“AI 机器人”。分层：

- **A 完整 Agent bridge**：源码确认 Lark ingress，并连接 coding agent、通用 tool-using agent 或 Agent runtime；不是一次 LLM 文本调用。
- **B workflow/agent app**：飞书事件触发公开工作流/Agent 平台，但会话、流式工具事件或权限闭环不完整。
- **C 托管参考**：官方可用，但关键入口未开源。
- **N 近邻/排除**：只有 SDK、出站 tool、普通 LLM bot、通知 webhook、空壳、归档或证据不足。

A/B 必须同时满足：公开源码；源码确认 ingress；源码或同仓库文档确认 Agent/tool/ACP/MCP/workflow；2024-01-01 后有活动或当前官方发布；至少两个一手链接。本仓库自身不参与社区项目计数，在后文单独审计与评分。

### 可复现检索

2026-08-20 使用 GitHub repository/code search：

- `(feishu OR lark OR 飞书) (claude-code OR codex OR kiro OR acp OR coding-agent OR agent bot)`
- `feishu bot tool calling`、`lark MCP agent`
- `repo:openclaw/openclaw feishu`
- `repo:langgenius/dify-official-plugins lark_trigger`
- `repo:labring/FastGPT feishu`
- `repo:AstrBotDevs/AstrBot lark`
- `repo:langbot-app/LangBot feishu`

对纳入项检查 README、Lark 适配层、Agent/tool 层和带日期的 commit/release；顺着 upstream/fork/package 链去重。“活跃”只表示链接所示日期至少有一次可核实活动，不保证该提交是绝对最新。

## 官方平台能力基线

### 事件、ack 与 SDK

官方[事件概述](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview?lang=zh-CN)说明失败会按 15 秒、5 分钟、1 小时、6 小时重推，最多 4 次；[长连接文档](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)规定：事件处理须在 3 秒内完成且不抛异常；每应用最多 50 个连接；集群中同一事件随机投给一个连接而非广播；长连接只承载事件订阅，不承载卡片 callback。故可靠 bridge 必须“鉴权/最小解析 → 持久 inbox/去重 → ack → 异步 Agent”，不能在 callback 内跑完整 Agent。

官方 [Node SDK](https://github.com/larksuite/node-sdk) 提供 `WSClient`；其 [Channel 文档](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md)覆盖消息归一化、去重/stale 窗、按会话串行、mention/allowlist、发送重试/降级、媒体和流式回复。至少在 [2026-06-24](https://github.com/larksuite/node-sdk/commit/965cdcbab14891d8a3a19547e4bca38d20d66ce0)仍有 WS 修复。Python 对应物是 [channel-sdk-python](https://github.com/larksuite/channel-sdk-python)，其 [PyPI](https://pypi.org/project/lark-channel-sdk/)显示 1.2.0 于 2026-07-14 发布。SDK 解决 transport，不解决 Agent session、持久队列、审批或多实例一致性。

### CardKit、身份与 tools

官方 [CardKit 流式指南](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview?lang=zh-CN)与[文本流式接口](https://open.feishu.cn/document/cardkit-v1/card-element/content?lang=zh-CN)提供原位更新；同卡 `sequence` 必须严格递增。Bridge 负责有序归约、限频、终态、30 KB / 200 元素预算、精确重试和不产生第二气泡的降级。

Bot tenant token 与 user OAuth token 权限语义不同。官方 [lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp)把 IM、Docs、Calendar、Bitable 等 OpenAPI 暴露为 MCP tools；[官方说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_introduction)区分托管远程 MCP 与本地自部署 MCP。0.5.1 可核实发布提交为 [2025-08-06](https://github.com/larksuite/lark-openapi-mcp/commit/ae40986e9cd55b3ff00633d99d925cb3e80bd2f5)，README 仍标 Beta。官方 [larksuite/cli](https://github.com/larksuite/cli)是 Agent 可用的 CLI/Skills；其 [lark-event skill](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md)输出 NDJSON 事件流，但两者都不是完整 Agent bridge。

| 层 | 官方已提供 | bridge/host 仍需负责 |
|---|---|---|
| 开放平台 | 事件投递、token、消息/媒体/CardKit、callback | 3 秒内安全接收、业务幂等、异步执行 |
| Channel SDK | transport、归一化、基础去重/策略/发送 | durable inbox、多实例一致性、Agent session、审批/取消 |
| MCP/CLI | Lark 能力作为 tools | tool allowlist、身份绑定、写操作确认、审计 |
| Agent runtime | 推理、上下文、tool loop、部分 session/cancel | IM 路由、AgentEvent、卡片投影、恢复与运维 |

## 项目清单

### A1. OpenClaw 上游 `@openclaw/feishu`

- **定位/入口**：通用 Agent host 的正式飞书 channel；[channel 文档](https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md)确认 DM、群聊、WS 默认/webhook 可选、流式卡片和 Lark tools；入口源码见 [`feishu-ingress.ts`](https://github.com/openclaw/openclaw/blob/4994f7bacf308269a0770b4a912c44a746cccec7/extensions/feishu/src/feishu-ingress.ts)。
- **runtime/session**：Gateway 管 models/tools/skills/sessions/subagents/ACP；按 chat/document 串行。认证事件在 dispatch 前 durable queue，event ID 去重，pending/retryable 跨重启恢复；WS 持久化失败会断开促使重投。
- **UX/tools**：CardKit streaming、工具状态、分块；doc/wiki/drive/Bitable tools与通用 skills/plugins。
- **security/ops**：DM pairing、群/用户 allowlist、mention gate、bot-loop protection；[安全说明](https://github.com/openclaw/openclaw#security)要求把入站视为不可信并配置 sandbox。未知：跨数据库节点灾备 SLO。
- **活跃度**：至少有 [2026-05-21 提交](https://github.com/openclaw/openclaw/commit/0fb1de5f73a14de553a752896e2d5277f480ed2c)。

### A2. `larksuite/openclaw-lark`

- **定位/入口**：飞书开放平台团队的 [OpenClaw 官方插件](https://github.com/larksuite/openclaw-lark)；事件/session/runtime 由 OpenClaw host 管理。
- **runtime/session/UX**：复用 OpenClaw Agent；按群绑定 skills/system prompt；README 明确 Thinking/Generating/Complete 卡片状态、流式文本和敏感操作确认按钮。
- **tools/security**：Messenger、Docs、Base、Sheets、Calendar、Tasks 读写；DM/群策略、allowlist。README 明示 user identity、prompt injection、越权和泄漏风险。可靠性主要继承宿主，插件未单独证明 durable inbox/HA。
- **活跃度**：至少有 [2026-06-03 提交](https://github.com/larksuite/openclaw-lark/commit/adaa568e76bab77c4a6efc44b52cfb35242d187c)。

### A3. `xufanglin/acp-link`

- **定位/入口**：[acp-link](https://github.com/xufanglin/acp-link)是 Rust 的飞书 WS ↔ ACP bridge。AWS 官方文章[《使用 Kiro CLI 和 ACP 构建飞书 AI 聊天机器人》](https://aws.amazon.com/cn/blogs/china/using-kiro-cli-agent-client-protocol-build-ai-chat/)于 2026-03-24 发布、2026-06-11 更新。
- **runtime/session**：topic 映射 ACP session；JSON-RPC/stdio 驱动 Kiro 或任意 ACP Agent；进程池按 topic 一致性哈希，Kiro 管上下文、skills、subagents、tools。
- **UX/tools**：流式卡片显示工具状态和附件；ACP 管 Agent，bridge 内嵌 Streamable HTTP MCP 让 Agent 反向发送文件/读文档，这是最清晰的双 seam。
- **security/ops**：Kiro `allowedTools`/shell allowlist；session/resource/log retention、映射落盘、systemd restart、热重载、cron。示例 MCP 无额外鉴权，跨主机必须补；未证明 event durable dedup、session lock、审批闭环。
- **活跃度**：至少有 [2026-05-12 附件恢复修复](https://github.com/xufanglin/acp-link/commit/596cc53419a383cf4260a63c49d12e306d6c2c09)。

### A4. `ZhiyuanChen/open-feishu`

- **定位/入口**：[OpenFeishu](https://github.com/ZhiyuanChen/open-feishu)既是 Python SDK，也有可部署 `feishu.agent.Agent`。统一 dispatcher 支持 WS/HTTP；README说明 HTTP 默认含签名新鲜度、防重放和去重；装配见 [`app.py`](https://github.com/ZhiyuanChen/open-feishu/blob/8497d5e5ce01307f662ef05ed82c7b0804541ac4/feishu/agent/app.py)。
- **runtime/session**：自带流式 backend、`ToolRegistry`、附件 sandbox、上下文压缩；[`AgentEngine`](https://github.com/ZhiyuanChen/open-feishu/blob/8497d5e5ce01307f662ef05ed82c7b0804541ac4/feishu/agent/loop.py)用 per-session `asyncio.Lock` 保护 history read-modify-write。
- **UX/tools/security**：流式 reasoning/text、进度/审批/OAuth 恢复卡；JSON Schema tools可声明 `requires_approval` 和 user OAuth scope；bot/user identity 分离。
- **reliability/ops**：SQLite session、pending approval/auth、execution result、shared file和 JSONL audit；[`persistence.py`](https://github.com/ZhiyuanChen/open-feishu/blob/8497d5e5ce01307f662ef05ed82c7b0804541ac4/feishu/agent/persistence.py)支持人在环跨重启恢复；HTTP 有 health/OAuth route。内存锁只保证单进程。
- **活跃度**：读取快照对应 [2026-07-17 提交](https://github.com/ZhiyuanChen/open-feishu/commit/8497d5e5ce01307f662ef05ed82c7b0804541ac4)。

### A5. `chenhg5/cc-connect`

- **定位/入口**：[cc-connect](https://github.com/chenhg5/cc-connect)连接 Claude Code、Codex、Gemini CLI、Cursor 等；[飞书文档](https://github.com/chenhg5/cc-connect/blob/main/docs/feishu.md)使用 WS 和卡片 action。
- **runtime/session**：多 workspace；`thread_isolation=true` 时每个根消息/thread 独立 Agent session。
- **UX/tools/security**：legacy/compact/card 三种 progress；卡片持续更新，失败可回落文本；显示 Bash/tool progress并承接权限请求。未证明所有 runtime 危险工具都强制统一审批。
- **reliability/ops**：WS 重连、thread 隔离、成员缓存、卡片降级；[2026-06-06 修复](https://github.com/chenhg5/cc-connect/commit/096ed3ea3da81f5a00b35889920aaf4646073700)以 `create_time` 水位丢弃陈旧重投。未见 durable inbox/跨进程 dedup。
- **活跃度**：至少有 [2026-06-06 提交](https://github.com/chenhg5/cc-connect/commit/096ed3ea3da81f5a00b35889920aaf4646073700)。

### A6. `deepcoldy/botmux`

- **定位/入口**：[botmux](https://github.com/deepcoldy/botmux)让 daemon 为每个飞书会话 spawn 独立 coding CLI/PTY；扫码 setup 可创建应用、配权限和发布。
- **runtime/session**：一会话一进程，topic 隔离；支持 relay、并行话题、多 bot、打断/重启/接管。源码 [`registry.ts`](https://github.com/deepcoldy/botmux/blob/master/src/adapters/cli/registry.ts)实际注册 Claude Code、Codex、Gemini、OpenCode、Kiro、Pi、OMP 等大量 adapter。
- **UX/tools/security**：每轮一张流式卡和可写 Web terminal；tools 来自 CLI。Web terminal 是高权限面，必须限制监听和访问；未证明统一 approval、durable inbox或多租户隔离。
- **reliability/ops**：daemon/autostart、CLI 探测、进程生命周期；事件幂等和崩溃后 session 恢复粒度未知。
- **活跃度**：至少有 [2026-05-21 提交](https://github.com/deepcoldy/botmux/commit/d5165a6bf6c9d2fefa2072c500ced0d664ddfab6)。

### A7. `op7418/Claude-to-IM-skill`

- **定位/入口**：[README](https://github.com/op7418/Claude-to-IM-skill/blob/main/README_CN.md)明确 IM → Node daemon → Claude Agent SDK/Codex SDK；飞书走 WS。
- **runtime/session**：sessions/bindings/permissions与按 session 的消息历史落盘，跨 daemon 重启。
- **UX/tools/security**：工具来自 runtime；飞书不是卡片流式权限 UI，而是 `/perm` 或 `1/2/3` 文本批准；凭据 `chmod 600`、日志脱敏。文本审批的操作者/session/防重放未证明。
- **reliability/ops**：PID/status、日志轮转、持久 session；事件幂等、per-chat 串行和 kill 策略未知。
- **活跃度**：可核实提交为 [2026-03-24](https://github.com/op7418/Claude-to-IM-skill/commit/536908f5e9bd65a151ca4cb4b08d3fedc1a43b4d)；不据此推断其后维护频率。

### A8. `wthislifehuh/lark-acp-bridge`

- **定位/入口**：[项目](https://github.com/wthislifehuh/lark-acp-bridge)以飞书 WS → JSON-RPC/stdio ACP 连接 Claude Code、Kiro、Codex、Gemini、Copilot、OpenCode、Amazon Q；README 标 WIP。
- **runtime/session**：每 chat 独立 session；支持 ACP `session/load` 的 Agent跨重启 resume；有 idle timeout/max chats。
- **UX/tools/security**：一任务一卡，合并 thinking/tool/final；per-tool permission card暂停 Agent，默认 5 分钟超时取消；支持 interruption。Lark tools需外接 CLI/MCP。
- **reliability/ops**：session store、idle eviction；未证明 durable inbox、callback 操作者绑定和多实例幂等。
- **活跃度**：至少有 [2026-07-12 提交](https://github.com/wthislifehuh/lark-acp-bridge/commit/cc97e62f2acb0cb4b1b5e57da3187200c95a502c)。

### A9. CowAgent（原 `chatgpt-on-wechat`）

- **定位**：项目已更名为 [CowAgent](https://github.com/zhayujie/CowAgent)，当前是具备规划、tool loop、长期记忆、skills、MCP与 sandbox 的 Agent Harness，不能沿用早期“普通 ChatGPT bot”定性。
- **入口/session**：[`feishu_channel.py`](https://github.com/zhayujie/CowAgent/blob/master/channel/feishu/feishu_channel.py)实现 WS/webhook、QR 注册、消息/媒体/卡片；Agent Core 管 session、记忆和知识。
- **UX/tools/security**：progress/static/scheduler cards；适配器有进程内 `ExpiredDict` dedup；内置文件、终端、浏览器、scheduler、memory、web和 MCP。配置尽量 0600，sandbox属宿主能力；durable dedup和卡片审批绑定未证明。
- **ops/activity**：CLI service、Docker、Web console；至少有 [2026-05-31 提交](https://github.com/zhayujie/CowAgent/commit/1dbf41f384f3ea71c0454a19e7f4abff454d4af0)。

### A10. AstrBot

- **定位/入口**：[AstrBot](https://github.com/AstrBotDevs/AstrBot)提供 Agent、MCP、skills、plugins、知识库与 sandbox；[`lark_adapter.py`](https://github.com/AstrBotDevs/AstrBot/blob/b8cd04e4da203eda88ef415f2fb2fb202135c3c5/astrbot/core/platform/sources/lark/lark_adapter.py)实现 socket/webhook及多媒体归一化，并迅速把 SDK callback 转成 async task。
- **runtime/session/UX**：统一 event queue → Agent/pipeline；上下文压缩、session sandbox；adapter声明 streaming，且 [v4.19.5](https://github.com/AstrBotDevs/AstrBot/blob/master/changelogs/v4.19.5.md)记录 Lark CardKit streaming。
- **tools/security/ops**：宿主原生 MCP/skills/plugins，sandbox隔离 code/shell；仅看到进程内 event ID 时间窗，未证明 durable dedup、按 chat 串行、统一写工具审批或多实例一致性。
- **活跃度**：至少有 [2026-05-21 提交](https://github.com/AstrBotDevs/AstrBot/commit/0711172fa7fb1ceabcc0bc8034d4740c385a76de)。

### A11. LangBot

- **定位/入口**：[LangBot](https://github.com/langbot-app/LangBot)支持多轮、tool calling、streaming、RAG、MCP、plugins与外部 Agent/workflow；[`lark.py`](https://github.com/langbot-app/LangBot/blob/7803d562546ab4d56d57ef61e2ebbb94f1a767d1/src/langbot/pkg/platform/sources/lark.py)包含 WS/webhook、CardKit、callback、auth和媒体限制。
- **runtime/session/UX**：多 pipeline/provider session；CardKit streaming有序号节流和 workflow form/card；媒体上限 10 MiB。
- **tools/security/ops**：tool calling、MCP、插件；README列 ACL、rate limit、敏感词、监控。未见 durable inbox、每 chat 串行和通用高风险 approval。
- **活跃度**：至少有 [2026-06-10 提交](https://github.com/langbot-app/LangBot/commit/bbc508d42fa564b48d314478a9e7affa6a2c67b5)。

### B1. Dify `Lark Trigger`

- **定位/入口**：[Lark Trigger](https://github.com/langgenius/dify-official-plugins/tree/main/triggers/lark_trigger)把消息、Drive、Calendar、Approval、Task、VC 等事件触发到 Dify workflow，不是原生对话 channel。公网 webhook 要求 App ID/Secret、Encrypt Key、Verification Token；[provider](https://github.com/langgenius/dify-official-plugins/blob/c41f1679f41ccffdc35b363123ac89f583a9d88c/triggers/lark_trigger/provider/lark.py)用官方 dispatcher 验证/解密并映射 `EventDispatch`。
- **runtime/session/UX**：Dify workflow/agent graph执行 tools/MCP；Trigger不提供按 chat/thread 的长期 session、串行、cancel或 Agent delta → 单卡 streaming。回复需工作流显式调用 [Feishu 出站 tool](https://github.com/langgenius/dify-official-plugins/blob/main/tools/feishu/tools/feishu_group_bot.yaml)。
- **security/ops**：webhook验证明确；event idempotency、ack/queue、tool identity未知。
- **活跃度**：插件仓至少有 [2026-06-17 提交](https://github.com/langgenius/dify-official-plugins/commit/ab0de0b8b2bd7d3b2267dd86c2d6cc92a6cd71ca)。

## 横向矩阵

`✓`=明确；`△`=部分/继承宿主；`—`=无；`?`=证据不足。持久 ingress 指 ack 前落盘与事件级去重，不是 session 文件。

| 项目 | 层 | ingress | Agent seam | session/context | streaming/card | Lark tools | 权限/审批 | 持久 ingress/恢复 |
|---|---:|---|---|---|---|---|---|---|
| OpenClaw Feishu | A | WS+webhook | Gateway/ACP | chat/doc 串行持久 | ✓ | ✓ | pairing/ACL/sandbox | ✓ durable/event ID/restart |
| larksuite plugin | A | host channel | OpenClaw | 继承 | ✓+确认 | ✓广 | ✓ | △继承 |
| acp-link | A | WS | ACP/stdio | topic+worker hash | ✓ | 内嵌 MCP | allowlist；MCP auth△ | session✓；event? |
| open-feishu | A | WS+webhook | AgentEngine | SQLite+session lock | ✓ | registry/MCP | ✓approval+OAuth | control state✓；多实例? |
| cc-connect | A | WS+callback | 多 CLI | chat/thread/workspace | ✓ | Agent提供 | △ | stale水位；durable? |
| botmux | A | WS | 多 CLI/PTY | 一会话一进程 | ✓+terminal | CLI提供 | △ | process✓；dedup? |
| Claude-to-IM | A | WS | Claude/Codex SDK | JSON持久 | 飞书流式— | Agent提供 | 文本审批 | session✓；dedup? |
| lark-acp-bridge | A | WS | ACP/stdio | chat+resume | ✓+权限卡 | 外接 | ✓ | session✓；inbox? |
| CowAgent | A | WS+webhook | Harness | memory/session | ✓ | ✓MCP | sandbox；审批? | 内存dedup；durable? |
| AstrBot | A | WS+webhook | Agent/MCP | pipeline/session | ✓ | ✓ | sandbox；审批? | 内存dedup；多实例? |
| LangBot | A | WS+webhook | tool/MCP/provider | multi-pipeline | ✓ | ✓ | ACL/rate；审批? | monitoring✓；inbox? |
| Dify Trigger | B | webhook | workflow graph | event payload | — | workflow | webhook验证 | queue/idempotency? |

## 可归纳的最佳范式

### 1. 摄取、ack、幂等

校验 signature/encryption/token/body → 解析最小 envelope → 以 `event_id` 为主键在同一事务写 inbox/dedup → ack → worker按 session partition消费。OpenClaw [durable ingress](https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md#inbound-durability)是公开样本最佳参照。幂等还须覆盖：stale redelivery（cc-connect [实际修复](https://github.com/chenhg5/cc-connect/commit/096ed3ea3da81f5a00b35889920aaf4646073700)）、outbound card/message ID、tool side-effect业务键和完成记录 retention。

### 2. 每会话串行、跨会话并行、可取消

路由键至少含 tenant/profile + chat + thread/root + workspace。同 key只允许一个 history read-modify-write；OpenFeishu 的 [session lock](https://github.com/ZhiyuanChen/open-feishu/blob/8497d5e5ce01307f662ef05ed82c7b0804541ac4/feishu/agent/loop.py)是最小参照。跨 key走有界 pool并设 tenant/user/session配额。新消息显式排队/打断/拒绝。cancel贯穿 card action → run token → ACP/SDK cancel → subprocess process group，终态必须是 `cancelled`。

### 3. 结构化 `AgentEvent`

建议内部 contract（归纳接口，不是假称上游标准）：

```json
{"v":1,"run_id":"run_...","session_id":"tenant:chat:thread","seq":42,"time":"2026-08-20T10:00:00Z","kind":"tool.call","payload":{"call_id":"tc_...","name":"shell","input":{}}}
```

OMP RPC 事件由同步 reducer 按到达顺序归约。terminal 是吸收态；tool lifecycle 按 ID 合并；隐藏 thinking 和原始工具输入输出不会进入用户投影。这样事件顺序、可见状态和交付状态保持分离。

### 4. streaming/card projection

RunState 是事实源，CardKit 是有预算的投影。每张卡只有一个 controller writer，按严格递增 sequence 串行更新并限流；journal 保存 card/message ID、下一 sequence 和最多一个精确 pending operation。终态先提交完整静态内容，再关闭 streaming。只有明确未提交时才允许 fallback；已知或结果不确定的气泡绝不补发。

### 5. 三层权限与 tool/MCP seam

- 触发层：pairing、群/用户 allowlist、mention、bot-loop guard；
- Agent层：sandbox、cwd/workspace、tool/command/network allowlist；
- Lark身份层：tenant token与user OAuth分离，token绑定 profile/user，模型不能选任意身份。

高风险写 tool两阶段确认：规范化 action/关键参数/nonce → callback验证操作者、tenant、session、call ID、expiry、nonce → 执行；pending state持久化。ACP/SDK/CLI adapter负责 Agent session/stream/cancel，MCP负责 tools，bridge负责身份、策略、审批和审计。MCP是协议，不是安全边界；本机绑定 loopback，跨主机需 TLS/auth/tenant isolation。

### 6. 恢复、观测与拓扑

持久化 inbox/dedup、route↔Agent session/workspace、run/last seq/cancel、card ID/sequence、pending approval/auth、tool idempotency/result、artifact TTL、audit。恢复时先重建 lease/锁，再 resume；不能 resume则明确 `interrupted`。

日志/trace/metric贯穿 tenant/profile、event、chat/thread（脱敏）、session、run、adapter、tool call、card。观测 ack latency、duplicate/stale、queue age、session wait、first-event/final、cancel/timeout、approval/auth wait、CardKit 429/fallback、WS reconnect、worker crash/resume。

部署：个人用单 daemon+WS+SQLite+subprocess；团队单节点拆 ingress/renderer与 worker；多节点/商店应用用 webhook→durable queue→session-sharded worker→renderer，数据库唯一键幂等、distributed lease保证每 session单消费者。多个 WS client不是广播。

## 反模式

1. 3 秒 callback 内跑 Agent；2. 只做内存 `message_id` 去重；3. 每 token 更新卡；4. stdout直接当协议；5. 全局 session或群聊不按 thread；6. 同会话并发写 history；7. 远程默认 `bypassPermissions`；8. 模型选择 token/profile；9. 把 MCP 当安全边界；10. 只存聊天文本不存 approval/auth/card/tool side effect；11. 把普通 LLM bot/出站 webhook称为 Agent bridge；12. 用 README 功能表代替 ingress/runtime源码。

## 近邻与排除

| 项目/能力 | 结论与证据 |
|---|---|
| Coze/扣子发布到飞书 | **C**。官方[发布文档](https://www.coze.cn/open/docs/guides/publish_to_feishu)说明托管发布；[Coze Studio](https://github.com/coze-dev/coze-studio)虽开源 Agent/workflow，但未核到对应 ingress源码。至少有 [2026-04-20 OAuth安全修复](https://github.com/coze-dev/coze-studio/commit/22275b1c2661d35344a7493cffe401e8cc61cf8e)。 |
| FastGPT飞书发布 | **C/N**。有[官方仓库文档](https://github.com/labring/FastGPT/blob/main/document/content/guide/build/publish/feishu.mdx)，但社区 handler [`[token].ts`](https://github.com/labring/FastGPT/blob/40d0713db336f22b7441e970297b590361423db7/projects/app/src/pages/api/support/outLink/feishu/%5Btoken%5D.ts)只代理到 pro service，关键 ingress/ack/session不可审计。主仓至少有 [2026-05-21 提交](https://github.com/labring/FastGPT/commit/05254ce0ec068cb174b7ec794f553fa474049c78)。 |
| 旧“Dify飞书 Bot” | **N**。main没有可核实原生对话 channel；现行一手路径是 B1 Trigger + 出站 tool，不能拼成流式 IM bridge。 |
| lark-openapi-mcp / larksuite CLI | **N 基础设施**。前者仅 tool面，后者是 CLI/NDJSON ingress原语；均缺完整 Agent loop/session/renderer。 |
| m1heng/clawdbot-feishu | **历史近邻**。[社区插件](https://github.com/m1heng/clawdbot-feishu)至少有 [2026-03-29 提交](https://github.com/m1heng/clawdbot-feishu/commit/b07885b756accb6756ddf696b60972a413317287)，能力已进入 OpenClaw上游，避免重复计数。 |
| ConnectAI-E/feishu-openai | **N 普通 LLM bot**：有 ingress，未核到当前通用 Agent/tool runtime。 |
| agents-to-im、feishu-claude-code、shareAI-lab/lark-channel、claude-code-lark | **N 小型/停滞候选**：活动集中 2026-03～05，本轮证据不足以同时覆盖入口、runtime、可靠性与两条稳定源码证据。 |
| qtc1229/connectbot-desktop-bridge 等 | **N 证据不足**：只有搜索结果/README声明，未核到足够适配层源码。 |
| 本地 lark-coding-agent-bridge | 不参与上面的社区项目计数；本地实现审计与对标见下一节。 |

## 本项目对标

### 结论先行

本项目已经采用了当前最佳范式中最难、也最容易出错的大半部分：官方 Channel 基座、按话题隔离的 session、每 scope 串行/跨 scope 有界并行、结构化 Agent 事件、流式卡片、可取消运行、策略指纹、签名回调和结构化日志。作为 **local-first coding-agent bridge**，它处于公开同类的第一梯队。

但它还不是端到端最佳实现。两个关键缺口都在 trust seam：

1. Agent 反向调用 Lark 仍主要依赖模型执行 `lark-cli` shell，而不是 bridge-owned、JSON Schema 化、服务端绑定身份与策略的 MCP tools。
2. 本地危险工具默认 `full`/`bypassPermissions`/`yolo`，`AgentEvent` 没有 approval request，飞书端无法形成可靠的人在环闭环。

按下面 12 个维度计：**6 项符合、4 项部分符合、2 项缺失**。因此准确判断是：**Lark 接入与运行编排基本是最佳范式；Agent 权限与双向 tools 还不是。**

### 当前链路

```text
Lark WS / Card / Comment
  → @larksuite/channel：验签/归一化/去重/stale/出站重试
  → intake：owner/admin/chat/mention gate
  → scope(chat | chat:thread | document) + 600ms debounce
  → RunPolicy：realpath、附件、access、sandbox、TTL、fingerprint
  → RunExecutor：scope reservation + FIFO process pool
  → OMP RPC
  → AgentEvent
  → unified OMP Reply reducer / renderer / controller
  → session catalog + logs
```

关键证据：

- [`startChannel`](../src/bot/channel.ts#L172-L526)复用 `@larksuite/channel`，配置 WS liveness、握手/REST timeout、proxy，并在断开时暂停新 run、终止进程和 flush 状态；依赖版本见 [`package.json`](../package.json#L46-L52)。
- [`PendingQueue`](../src/bot/pending-queue.ts#L23-L102)、[`ActiveRuns`](../src/bot/active-runs.ts#L8-L101)和 [`RunExecutor`](../src/runtime/run-executor.ts#L46-L244)共同实现同 scope 单 run、运行中消息合并、全局 FIFO 上限、取消及终态清理。
- [`OmpRunEngine` / `AgentEvent`](../src/agent/types.ts)是 OMP-only seam：RPC 事件由单一 reducer 归约，再交给统一 Reply controller。
- [`startRunFlow`](../src/bot/run-flow.ts#L74-L199)在 spawn 前统一做 workspace、access、附件和 capability 决策；[`evaluateRunPolicy`](../src/policy/run-policy.ts#L90-L158)生成有 TTL 的 immutable policy 与 fingerprint，session 只在 agent/cwd/policy 兼容时 resume。
- [`CallbackAuth`](../src/card/callback-auth.ts#L64-L142)把 run、scope、chat、operator、action、policy fingerprint、expiry 与 single-use nonce 一起签名；[`CallbackNonceStore`](../src/card/callback-store.ts#L7-L62)跨重启保存 replay 状态。这一项优于多数公开同类。
- [`runAgentBatch`](../src/bot/channel.ts)先创建唯一 CardKit Reply，再按序投影 OMP 进度和终态；topic 定位、限流、精确重试、fallback 和重启恢复都封装在统一 controller 内。
- [`logger`](../src/core/logger.ts#L19-L180)用 `AsyncLocalStorage` 传播 trace/chat/message context，写 JSONL、保留期和凭据脱敏；[`RunExecutor`](../src/runtime/run-executor.ts#L132-L187)记录 queue wait、duration、termination 与 policy dimensions。

### 逐项评分

| 维度 | 评价 | 证据与差距 |
|---|---|---|
| 官方 transport/归一化 | 符合 | 复用 `@larksuite/channel`，没有再造 WS、mention、媒体和 streaming transport。 |
| event 去重/快速摄取 | 部分符合 | SDK 有内存 dedup/stale gate；本项目 handler 很快入自己的 queue，但没有 durable inbox 与跨重启 event ID 唯一键。个人 WS 模式足够，HA 不够。 |
| session scope | 符合 | p2p/group 用 chat，topic 用 `chat:thread`，comment 用 document scope；不会跨话题串上下文。 |
| 每 scope 串行/跨 scope 并行 | 符合 | reservation 消除 submit 竞态，pending block/unblock 串行，FIFO pool 限总并发。 |
| Agent seam | 符合 | 统一 typed `AgentEvent` 和 OMP `stop/wait` contract；没有多 adapter 选择。 |
| streaming/card UX | 符合 | 一个 CardKit Reply 原位展示安全的 tool/reasoning/final 状态，并保留 topic 定位、预算和恢复语义。 |
| 触发权限与 callback | 符合 | 默认私有、owner/admin/chat/mention gate；callback HMAC、operator/context/fingerprint、TTL、nonce replay protection 完整。 |
| Lark 结构化 tools | 符合 | run-scoped `lark_bridge` MCP 提供常用 bot reads、消息、Docx、CardKit、图片、用户 OAuth 和拉群能力；长尾 OpenAPI 不做全量复制。 |
| 危险工具人在环 | 部分符合 | 原生 Lark 写工具通过原会话中的签名确认卡审批；通用 OMP 工具审批仍由 OMP 自身负责。 |
| 最小权限与 sandbox | 部分符合 | workspace policy 会验证工作目录和附件，但 OMP 使用 `yolo` approval mode；工作目录不是文件系统 sandbox。 |
| 身份/OAuth | 符合 | 个人版私聊可按需获得 user OAuth；团队版、群聊、话题、文档评论和会议 run 只使用 bot 身份。 |
| 恢复与可观测 | 部分符合 | session/catalog/config/nonce/log 和 active Reply delivery 可恢复；旧 OMP RPC run 不能重连，因此重启后在原气泡标为 interrupted。 |

### 与主要参照的差异

| 参照 | 值得借鉴 | 本项目更强的地方 |
|---|---|---|
| OpenClaw Feishu / `larksuite/openclaw-lark` | durable ingress、完整 Lark tools、敏感操作确认、成熟 host | 更聚焦本地 coding CLI；policy fingerprint、callback context binding 和少依赖更容易审计。 |
| `acp-link` | ACP 管 Agent，内嵌 MCP 管反向 Lark tools；双 seam 最清楚 | 本项目的 access、附件策略、callback、防重放、fallback 与 observability 更完整。 |
| OpenFeishu Agent | JSON Schema tools、approval/OAuth 卡、SQLite pending state 与跨重启恢复 | 本项目直接复用成熟 coding agent，不重建 model/tool loop；三个 adapter 的协议漂移测试面更清晰。 |
| cc-connect / botmux | 多 IM、多 CLI、daemon/process 管理范围广 | 本项目 topic/session policy、签名 callback 和 Lark 原生 UX 更深，接口也更小。 |
| `lark-acp-bridge` | per-tool permission card、ACP resume/cancel | 本项目 transport、access、policy、stream fallback 和运维闭环更成熟。 |

### 最小改进路线

#### P0：把身份和写操作从 prompt 约定提升为 server-side policy

不要重写 OAuth，也不要直接替换掉 `lark-cli`。按已有[原生调用调研](./lark-native-integration-research.md)的最小路线：

1. bridge 内 bot-only OpenAPI 先复用 `channel.rawClient`，删除重复 tenant token/fetch。
2. 增加一个仅绑定 loopback、由 bridge 持有 profile/identity 的最小 Streamable HTTP MCP endpoint。
3. 第一批只开放真实需要的 read-only tools；tool schema 不允许模型传 profile、token 或任意 identity。
4. 写 tool 必须返回 `confirmation_required`，规范化 action/关键参数并签一次性 nonce；沿用现有 callback auth 后再执行。
5. user OAuth 与 refresh 继续交给 `lark-cli` 当 auth broker，直到 OS keychain、refresh locking、rotation、revoke 和行为测试齐全。

这一步同时消除“模型拼 shell/解析 stdout”和“安全规则只写在 system prompt”两个根因。

#### P1：补齐 Agent approval event，但不要先造通用框架

在现有 `AgentEvent` 增加 `approval_requested` / `approval_resolved`，由真正能暴露 permission hook 的 adapter 实现；Lark 卡片显示 tool、规范化参数、风险和 approve/deny。要求：

- 默认 deny + timeout；回调绑定 operator、scope、run、tool call、policy fingerprint 与 nonce。
- approval 未决时持久化最小状态；重启后不能恢复的请求明确 deny/interrupted。
- 完成 MCP/auth broker 后，再把新 Claude/Codex profile 的默认权限降到 `workspace`；`full` 显式 opt-in。
- OMP 在没有可强制 sandbox/approval 前继续 fail closed，不静默放宽。

只有出现第二个真实 [ACP](https://agentclientprotocol.com/get-started/introduction) runtime 时再加 ACP adapter；当前三种内部 adapter 已构成真实 seam，重写成 ACP 不会自动增加安全性。

#### P1（仅 team mode）：有界排队与 actor 配额

当前 process pool 有并发上限，但 `waiters` 和 pending messages 没有容量/年龄上限。个人默认私有模式风险低；进入 team mode 时再增加 per-actor/session rate limit、最大 batch/queue age 和明确的 busy/retry 响应。

#### P2（仅 24×7/HA 产品化）：durable ingress/outbox

如果目标从“个人本机 bridge”升级为团队常驻或多节点，再加入 SQLite/Postgres inbox/dedup、run lease、outbound/card sequence、tool idempotency、重启后 stale card reconciliation 和 OTel。当前不要为了理论 HA 引入 broker、分布式锁或新框架。

### 最终判断

- **是否用了当前最佳范式？** 用了，而且 Lark transport、scope/session、Agent seam、streaming、并发取消、callback 安全是本项目的优势。
- **是否已经是完整最佳实践？** 不是。`lark-cli` shell tool seam、默认高权限、没有 Lark approval loop 是明确差距。
- **是否应该迁到 OpenClaw/DeerFlow/另一套大框架？** 不应该。当前模块已经够深；最小正确升级是补 bridge-owned MCP 与 approval 两条 seam，而不是替换整个 runtime。
- **产品边界是否合理？** 合理。单 daemon + WS + 本地 CLI 是个人 coding agent 的正确拓扑；durable queue/HA 只在团队化需求出现时建设。

## 证据局限

1. “所有”只代表上述查询、GitHub可见索引、官方生态与活动门槛；不覆盖私有/内部、未索引或已删除项目。
2. 活跃度链接是可核实下界，不总是绝对最新 commit。
3. OpenClaw、OpenFeishu、Dify Trigger、FastGPT handler、AstrBot、LangBot读取了适配源码；部分 coding bridge依据 README、配置、adapter registry和实质修复提交，未知项明确标 `?`。
4. Coze和FastGPT Pro内部 ack、幂等、session、卡片、权限不可审计，只列 C/N。
5. allowlist、sandbox或approval按钮不等于完成安全审计，仍需另验 callback操作者绑定、nonce/expiry、token storage、SSRF、process isolation和跨租户路径。
6. 按要求没有启动候选、没有运行测试或验证命令；结论是静态一手资料审计，不是互操作/压力测试。
