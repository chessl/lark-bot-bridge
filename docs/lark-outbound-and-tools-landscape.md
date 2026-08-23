# Lark / 飞书 Agent 项目：消息出口与 Lark tools 地形

> 证据截止：2026-08-20。样本与去重口径沿用 [`agent-bridge-process-topology-research.md`](./agent-bridge-process-topology-research.md)：A1–A11、B1，共 12 项；ACP upstream/fork family 只计 A8 一项。仅使用项目自身源码、README 与飞书官方 SDK/API 文档。

## 1. 口径

本文把四件容易混淆的事分开：

1. **普通消息出口**：Agent 的主回复如何由 bridge/channel 创建、回复、更新或流式刷新；这是产品热路径。
2. **Agent 可调用的 Lark tool schema**：明确注册给模型/Agent 的独立工具名；只按 registry、plugin manifest 或 MCP `tools/list` 中的 schema 计数。
3. **能力域与 action**：一个 tool 内部可 multiplex 多个 `action`，仍只算一个 schema；反之同一能力域可拆成多个 schema。
4. **外接能力**：宿主支持通用 MCP/plugin/shell，或 README 建议安装 `lark-cli`，不等于项目内建 Lark tool。`lark-cli` 的 200+ 命令从不计入下面的项目内建数。

因此，`cc-connect send` / `botmux send` 是项目自己的回传 CLI/IPC 命令，不是注册给 Agent 的 Lark JSON-schema tool；Dify 的 Lark Trigger 是事件 trigger，也不是出站 tool。

## 2. 结论先行

- 12 项中，**11 个对话型项目的普通主回复都由 bridge/channel 进程内 client/SDK 发出**；B1 不是对话 channel，必须由 workflow 显式调用出站 tool。没有项目把普通主回复交给 `lark-cli`。
- 内建 Lark tool 分布：**广域 suite 3/12**（A1、A2、A4），**窄 tool 2/12**（A3、B1），**0 个内建 Lark tool 7/12**（A5–A11）。
- 精确 schema 数依次为：`14, 39, 2, 58/59, 0, 0, 0, 0, 0, 0, 0, 1`。排序后第 6、7 项均为 0，故**中位数为 0**；基础总数 114，启用 A4 条件工具时 115。均值约 9.5 很容易被三个广域 suite 误导。
- 明确文档化“外接全量 Lark CLI/MCP”的项目是 **2/12**：A1 的可选官方 `lark-cli` skill、A8 的推荐 `lark-cli`/skills。它与前三类正交：A1 同时有内建 suite；A8 的项目内建数仍为 0。
- A10 AstrBot 与 A11 LangBot 的 **CardKit 流式卡片结论成立**：两者都由 Lark adapter 把宿主流式输出投影成卡片更新；但其通用 MCP/plugins 并未在仓库中注册成 Lark-specific tools，故工具数仍为 0。

## 3. 逐项目出口与工具矩阵

| 项目 | 普通消息出口：client / create、reply、update、stream | Agent/runtime event → renderer / presenter | 内建 Lark tool schema | 能力域与外接能力 |
|---|---|---|---:|---|
| **A1 OpenClaw `@openclaw/feishu`** | Gateway 内 `@larksuiteoapi/node-sdk`；outbound 模块发送/回复文本、post、卡片和媒体；partial reply 进入 [`reply-dispatcher.ts`](https://github.com/openclaw/openclaw/blob/f20c6dacc34fcc91cfee85a6e2f0d63084fa9a15/extensions/feishu/src/reply-dispatcher.ts)，[`streaming-card.ts`](https://github.com/openclaw/openclaw/blob/f20c6dacc34fcc91cfee85a6e2f0d63084fa9a15/extensions/feishu/src/streaming-card.ts)创建 CardKit 卡、合并 delta、递增 sequence 更新并在终态关闭；失败回落普通消息。 | OpenClaw agent reply events → channel reply dispatcher → streaming-card / send client。出口是深 presenter，不是 tool call。 | **14** | app scopes、Bitable、chat、doc、drive、perm、wiki。另有可选官方 `lark-cli` skill；不计入 14。 |
| **A2 `larksuite/openclaw-lark`** | Gateway 插件内 `LarkClient` + `@larksuiteoapi/node-sdk`；[`messaging/outbound/send.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/messaging/outbound/send.ts)负责 send/reply/update/edit，[`card/streaming-card.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/streaming-card.ts)和 reply dispatcher 负责 Thinking/Generating/Complete 与流式刷新。 | OpenClaw reply/tool lifecycle → card reply-dispatcher / stream update handler → outbound client。 | **39** | IM、文档、知识库、云盘、搜索、表格、多维表格、日历、任务、联系人、OAuth、交互问答；插件自身是广域 suite。 |
| **A3 `xufanglin/acp-link`** | Rust 自研 `FeishuClient`，WS 入站、REST 出站；[`FeishuChannel`](https://github.com/xufanglin/acp-link/blob/596cc53419a383cf4260a63c49d12e306d6c2c09/src/im/feishu/channel.rs)把 `reply_message` 映射为 reply card、`update_message` 映射为 card update，并提供 send/upload；ACP 流式通知持续改同一卡片。 | ACP JSON-RPC session update → link 层聚合文本/tool 状态 → `IMChannel.reply_message/update_message` → Feishu client。 | **2** | `feishu_send_file`、`feishu_get_document`；内嵌 Streamable HTTP MCP，仅覆盖文件回传与文档读取。 |
| **A4 `ZhiyuanChen/open-feishu`** | 自研 async [`FeishuClient`](https://github.com/ZhiyuanChen/open-feishu/blob/8497d5e5ce01307f662ef05ed82c7b0804541ac4/feishu/client.py)，非官方 SDK；[`Agent`](https://github.com/ZhiyuanChen/open-feishu/blob/8497d5e5ce01307f662ef05ed82c7b0804541ac4/feishu/agent/app.py)装配 WS/HTTP dispatcher、engine 与 client。engine 流式 reasoning/text、tool/approval/OAuth progress 由 progress/card presenter 创建、更新并终结卡片。 | backend stream → `AgentEngine` → progress / approval / OAuth card projection → client。pending approval/auth 可跨重启恢复。 | **58 基础；59 条件性** | Calendar、rooms、docs/wiki、tasks、Bitable、approval、VC、Sheets、Mail、contacts、whiteboard、shared files；`describe_shared_file` 仅有 analyzer 时注册。可接通用 MCP，但不影响内建数。 |
| **A5 `chenhg5/cc-connect`** | Go daemon 内官方 `larksuite/oapi-sdk-go/v3`；WS + card action；支持 legacy/compact/card progress，card 模式创建一张进度卡并持续更新，失败降级文本；入口与配置见[`飞书文档`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/docs/feishu.md)。 | CLI/PTY adapter 的结构化/终端事件 → session progress renderer → Feishu SDK send/update。 | **0** | `cc-connect send --image/--file/--tts` 是自家 CLI/daemon IPC 回传，不是 Agent tool registry；见 [`send.go`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/cmd/cc-connect/send.go)。 |
| **A6 `deepcoldy/botmux`** | daemon/worker 内 `@larksuiteoapi/node-sdk`；每轮创建流式卡，worker 解析 PTY 输出后更新卡片；依赖与 worker 见 [`package.json`](https://github.com/deepcoldy/botmux/blob/d5165a6bf6c9d2fefa2072c500ced0d664ddfab6/package.json)、[`worker.ts`](https://github.com/deepcoldy/botmux/blob/d5165a6bf6c9d2fefa2072c500ced0d664ddfab6/src/worker.ts)。 | CLI adapter/PTY output → worker turn state → Lark card updater；daemon 负责路由与生命周期。 | **0** | `botmux send` / 注入命令是当前 thread 的自家回传通道，不是注册表中的 Lark tool。 |
| **A7 `op7418/Claude-to-IM-skill`** | Node daemon 内 `@larksuiteoapi/node-sdk` WS/REST；bridge 主体来自兄弟仓 `op7418/Claude-to-IM`。[`feishu-adapter.ts`](https://github.com/op7418/Claude-to-IM/blob/d93a8b447c453829ac4bbc6a7f721e42bf037147/src/lib/bridge/adapters/feishu-adapter.ts)用 `im.message.create` 发 interactive/post/text，并以 CardKit v2 `card.create(streaming_mode)` → `streamContent`（sequence、200 ms 节流）→ 关闭 streaming/final update；失败时权限交互才降级 `/perm` 或 `1/2/3` 文本。 | Claude/Codex SDK events → [`bridge-manager.ts`](https://github.com/op7418/Claude-to-IM/blob/d93a8b447c453829ac4bbc6a7f721e42bf037147/src/lib/bridge/bridge-manager.ts) 的 `onMessageStart/onStreamText/onToolEvent/onStreamEnd` → Feishu adapter/CardKit presenter。 | **0** | tools 来自 Claude/Codex runtime；无 Lark-specific registry、无 lark-cli。**流式卡片成立。** |
| **A8 `wthislifehuh/lark-acp-bridge`** | Node bridge 内 `@larksuiteoapi/node-sdk`；[`lark-http.ts`](https://github.com/wthislifehuh/lark-acp-bridge/blob/e458ccaa7626e65a4324bd38b3ed7e6e10999f91/src/lark/lark-http.ts)用 `im.message.reply/create` 发 interactive/post，并用 `im.message.patch` 反复更新同一张 Card JSON 2.0 卡；这是整卡 patch，不是 CardKit streaming。 | ACP session notifications → [`lark-presenter.ts`](https://github.com/wthislifehuh/lark-acp-bridge/blob/e458ccaa7626e65a4324bd38b3ed7e6e10999f91/src/presenter/lark-presenter.ts) 聚合 thinking/tool/final（300 ms 合并）→ Lark client patch；另有权限卡、中断和终态。 | **0** | [`README`](https://github.com/wthislifehuh/lark-acp-bridge/blob/e458ccaa7626e65a4324bd38b3ed7e6e10999f91/README.md)强烈建议外接 Lark CLI/skills；这是 agent 自主的可选外部进程，不是 bridge 内建 tool。 |
| **A9 CowAgent** | Python channel 内 `lark_oapi`（WS/webhook）和部分直接 OpenAPI；[`feishu_channel.py`](https://github.com/zhayujie/CowAgent/blob/286cdaff26f3f7c8c45f0bb4b805d14ff01652c3/channel/feishu/feishu_channel.py)把统一 `Reply` 映射为 text/image/file/audio/card，并以 CardKit v1 REST 创建 streaming card、更新 element content/sequence、关闭 streaming，失败降级非流式。 | `AgentStreamExecutor` events → ChatService/channel callback → [`FeishuProgressState`](https://github.com/zhayujie/CowAgent/blob/286cdaff26f3f7c8c45f0bb4b805d14ff01652c3/channel/feishu/feishu_progress_card.py) → `lark_oapi`/CardKit REST。 | **0** | 宿主有 17 个通用 tools 与动态 MCP，但仓库未注册 Lark-specific tool；无 lark-cli。 |
| **A10 AstrBot** | Python `lark_oapi` socket/webhook；[`lark_adapter.py`](https://github.com/AstrBotDevs/AstrBot/blob/b8cd04e4da203eda88ef415f2fb2fb202135c3c5/astrbot/core/platform/sources/lark/lark_adapter.py)声明并实现 streaming，CardKit 创建卡片后按流片更新并在完成时收口；普通媒体走 SDK send/upload。 | 宿主 event queue / result chain → Lark platform event renderer → CardKit session/update；[v4.19.5 changelog](https://github.com/AstrBotDevs/AstrBot/blob/master/changelogs/v4.19.5.md)明确记录 Lark CardKit streaming。 | **0** | MCP、skills、plugins 是宿主通用能力；仓库未内建 Lark tool registry。**流式卡片成立。** |
| **A11 LangBot** | Python `lark_oapi`，WS/webhook；[`lark.py`](https://github.com/langbot-app/LangBot/blob/7803d562546ab4d56d57ef61e2ebbb94f1a767d1/src/langbot/pkg/platform/sources/lark.py)含普通消息/媒体、CardKit create、sequence 更新、节流与 workflow form/card callback。 | pipeline/provider streaming output → Lark adapter 的 streaming-card state → CardKit content update/finalize。 | **0** | tool calling、MCP、plugins 是平台通用 seam；无仓库内建 Lark-specific schema。**流式卡片成立。** |
| **B1 Dify `Lark Trigger` + Feishu tool** | Trigger 只把 Lark webhook 事件变成 `EventDispatch`，**没有主回复 renderer**。回复必须由 workflow 显式调用 `feishu_group_bot`；实现用 `httpx.post` 调自定义群机器人 webhook，固定 `msg_type=text`，无 reply/update/card/stream。见 [`provider/lark.py`](https://github.com/langgenius/dify-official-plugins/blob/c41f1679f41ccffdc35b363123ac89f583a9d88c/triggers/lark_trigger/provider/lark.py)、[`feishu_group_bot.py`](https://github.com/langgenius/dify-official-plugins/blob/c41f1679f41ccffdc35b363123ac89f583a9d88c/tools/feishu/tools/feishu_group_bot.py)。 | trigger event → Dify workflow/agent graph → 显式 tool invoke；没有 AgentEvent→单卡流式 presenter。 | **1** | `feishu_group_bot`，只发群文本 webhook；消息/Drive/Calendar/Approval/Task/VC 等 trigger 能力域不是出站 tools。 |

## 4. 可追溯的 tool schema 清单

### A1：14 个

来源：[`extensions/feishu/openclaw.plugin.json`](https://github.com/openclaw/openclaw/blob/f20c6dacc34fcc91cfee85a6e2f0d63084fa9a15/extensions/feishu/openclaw.plugin.json) 的 `contracts.tools`。

`feishu_app_scopes`、`feishu_bitable_create_app`、`feishu_bitable_create_field`、`feishu_bitable_create_record`、`feishu_bitable_get_meta`、`feishu_bitable_get_record`、`feishu_bitable_list_fields`、`feishu_bitable_list_records`、`feishu_bitable_update_record`、`feishu_chat`、`feishu_doc`、`feishu_drive`、`feishu_perm`、`feishu_wiki`。

这里 `feishu_doc`、`feishu_chat` 等可在一个 schema 内承载多个 action；仍只各算 1 个。Bitable 则拆成 9 个独立 schema。

### A2：39 个

来源：[`openclaw.plugin.json`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/openclaw.plugin.json) 的 `contracts.tools`。

- Bitable：`feishu_bitable_app`、`feishu_bitable_app_table`、`feishu_bitable_app_table_field`、`feishu_bitable_app_table_record`、`feishu_bitable_app_table_view`
- Calendar：`feishu_calendar_calendar`、`feishu_calendar_event`、`feishu_calendar_event_attendee`、`feishu_calendar_freebusy`
- Chat / IM / media：`feishu_chat`、`feishu_chat_members`、`feishu_im_bot_image`、`feishu_im_user_fetch_resource`、`feishu_im_user_get_messages`、`feishu_im_user_get_thread_messages`、`feishu_im_user_message`、`feishu_im_user_search_messages`
- Docs / Drive / Wiki / Search / Sheets：`feishu_create_doc`、`feishu_doc_comments`、`feishu_doc_media`、`feishu_drive_file`、`feishu_fetch_doc`、`feishu_search_doc_wiki`、`feishu_sheet`、`feishu_update_doc`、`feishu_wiki_space`、`feishu_wiki_space_node`
- Users / auth / interaction：`feishu_get_user`、`feishu_search_user`、`feishu_oauth`、`feishu_oauth_batch_auth`、`feishu_ask_user_question`
- Tasks：`feishu_task_comment`、`feishu_task_subtask`、`feishu_task_task`、`feishu_task_agent`、`feishu_task_attachment`、`feishu_task_tasklist`、`feishu_task_section`

这些 schema 中不少以 action enum multiplex CRUD；39 是模型实际看到的工具名数，不是底层 OpenAPI endpoint 数。

### A3：2 个

来源：[`mcp_tools.rs`](https://github.com/xufanglin/acp-link/blob/596cc53419a383cf4260a63c49d12e306d6c2c09/src/im/feishu/mcp_tools.rs) 的固定 `vec!` 与 call dispatch：`feishu_send_file`、`feishu_get_document`。

### A4：58 个基础 + 1 个条件工具

来源：[`feishu/agent/bundles/workplace.py`](https://github.com/ZhiyuanChen/open-feishu/blob/8497d5e5ce01307f662ef05ed82c7b0804541ac4/feishu/agent/bundles/workplace.py) 的 `_build_workplace_tool_registry()`。逐个 `registry.add` 统计：

- Calendar（6）：`list_calendar_events`、`query_calendar_freebusy`、`create_calendar_event`、`update_calendar_event`、`cancel_calendar_event`、`respond_to_invite`
- Rooms（4）：`list_meeting_room_buildings`、`list_meeting_rooms`、`query_meeting_room_freebusy`、`book_meeting_room`
- Docs / records read（4）：`search_documents`、`get_document_content`、`get_message_thread`、`get_meeting_record`
- Tasks（4）：`create_task`、`list_my_tasks`、`update_task`、`delete_task`
- Bitable（4）：`create_bitable_record`、`list_bitable_records`、`update_bitable_record`、`delete_bitable_record`
- Approval（9）：`list_approval_definitions`、`get_approval_definition`、`create_approval_instance`、`get_approval_status`、`approve_approval_task`、`list_my_pending_approvals`、`list_my_payment_accounts`、`reject_approval_task`、`cancel_approval_instance`
- VC（3）：`reserve_meeting`、`update_reservation`、`cancel_reservation`
- Doc write（5）：`create_document`、`append_to_document`、`list_document_blocks`、`update_document`、`delete_document`
- Sheets（4）：`append_to_sheet`、`update_sheet_range`、`delete_sheet_rows`、`read_sheet_range`
- Mail（7）：`list_mail_messages`、`search_mail_messages`、`get_mail_message`、`summarize_mail_message`、`summarize_mail_messages`、`list_mail_folders`、`send_mail_message`
- People / whiteboard（2）：`find_user`、`list_whiteboard_nodes`
- Task comments（4）：`comment_on_task`、`list_task_comments`、`update_task_comment`、`delete_task_comment`
- Shared files 基础（2）：`list_shared_files`、`upload_shared_file_to_drive`
- Shared files 条件（1）：`describe_shared_file`，仅 `describe_analyzer is not None` 时注册

分组和为 58；条件成立时为 59。这里是原子 tool factory 数，不是能力域数（13 个分组），也不是底层 HTTP endpoint 数。

### B1：1 个

来源：[`feishu_group_bot.yaml`](https://github.com/langgenius/dify-official-plugins/blob/c41f1679f41ccffdc35b363123ac89f583a9d88c/tools/feishu/tools/feishu_group_bot.yaml) 的唯一 tool manifest：`feishu_group_bot`。Lark Trigger 目录下的多个事件类型不进入此计数。

### 其余 7 项：0 个

A5、A6 有自家回传命令但没有 Lark tool schema；A7 只有 Agent runtime tools；A8 依赖外接；A9–A11 只有宿主级通用 tools/MCP/plugins。它们都不能因为“理论上能连官方 Lark MCP”而被改写成“仓库内建 Lark tools”。

## 5. 聚类与统计

| 聚类 | 数量 | 项目 | 判定 |
|---|---:|---|---|
| 广域 suite | **3/12** | A1、A2、A4 | 覆盖多个办公域，有明确 registry/manifest；14、39、58/59 个 schema |
| 窄回传/单点工具 | **2/12** | A3、B1 | A3 两个 MCP tools；B1 一个群文本 webhook tool |
| 无内建 Lark tools | **7/12** | A5、A6、A7、A8、A9、A10、A11 | 自家 CLI、runtime tools、通用 MCP/plugin 或外接建议均不等于内建 Lark schema |
| 明确外接全量 CLI/MCP（正交） | **2/12** | A1、A8 | 项目文档明确提到官方/推荐的 Lark CLI/skills；不并入项目内建数 |

这三种内建分类互斥且合计 12；“外接全量”是正交标签。内建 schema 数的中位数为 0，说明公开 bridge 的常态不是复制一套飞书 OpenAPI，而是把普通回复做好，再把长尾能力留给宿主 tools、MCP、skills 或外部 CLI。

## 6. 为什么消息出口通常很深，而 tools 通常很浅

普通回复是每轮都必须成功的热路径。它至少要携带 chat/thread/root/message 身份，选择 create 或 reply，处理 text/post/card/media，上传附件，建立 card/message ID，合并高频 delta，严格推进 CardKit sequence，节流并发更新，展示 tool/approval 状态，确保 terminal 唯一，处理 429/超时/过期卡并降级。这自然形成：

```text
Agent/runtime events
  → session/run 状态
  → channel reply dispatcher
  → renderer / card presenter
  → SDK/client create|reply|update
  → stream finalize / fallback
```

Lark tools 则是可选侧路。若要做成可靠广域 suite，每个能力还需 schema、bot/user identity、OAuth scope、分页、资源下载、幂等、写操作确认和审计；维护成本按办公域扩张。多数项目已有 shell、MCP、plugin 或 coding-agent tools，因此停在更浅的三种实现：0 个、只做文件/文本回传、或把全量能力外接。只有 A1/A2/A4 把这一成本内收。

“tools 浅”不表示某个 tool 的 HTTP 实现一定简单，而是说 **bridge 与 Agent 的注册 seam 通常很窄**；消息出口虽然只是一类能力，却必须深度吸收会话、流式 UI 和平台可靠性语义。

## 7. 本仓库对照

本仓库不进入上述 12 项统计，其位置很明确：

| 维度 | 本仓库实现 |
|---|---|
| 普通消息出口 | `AgentEvent` 先由 [`reduce`](../src/card/run-state.ts#L43-L139) 归并成 `RunState`，再由 [`renderCard`](../src/card/run-renderer.ts#L22-L65) / `renderText` 投影；[`channel.ts`](../src/bot/channel.ts#L1093-L1249) 根据配置选择 CardKit 2.0 流式卡、流式 markdown 或最终单次 text，并通过同进程 `@larksuite/channel` 的 `channel.stream` / `channel.send` 发出。主回复不经过 lark-cli。 |
| 项目内建 Lark tool schema | **0**。仓库没有把 `channel.rawClient` 包成 Agent 可见的 MCP/JSON-schema tools；会议和 Console 的直接 OpenAPI/CLI 调用属于 bridge 内部功能，不计入 Agent tool registry。 |
| Agent 的 Lark 能力 | [`bridge-system-prompt.ts`](../src/agent/bridge-system-prompt.ts#L62-L128) 要求 Agent 通过通用 shell tool 启动外部 `lark-cli`；preflight 对用户描述其覆盖“200+ 飞书/Lark API commands”：[preflight.ts](../src/cli/preflight.ts#L66-L73)。因此模型实际看到的结构化 schema 仍只是 Bash/shell，而不是 200 多个 Lark tool schemas。 |
| 取舍 | 能力宽度接近“外接全量”，但接口深度低于 A1/A2/A4：参数由模型拼命令行，结果经 stdout/stderr，且每次多一个进程；优势是直接复用 lark-cli 的 OAuth、身份策略、长尾覆盖和写操作门禁。 |

所以本仓库在这张分布图里应标成：**内建 0 + 外接全量 CLI**。它与 A8 最接近，但集成更强——会自动安装、绑定 profile、注入环境和运行约定。若把常用能力迁到 bridge-owned MCP，本仓库会从“0 + 外接全量”变成“少量高频结构化 tools + CLI 长尾 fallback”，仍无需复制 14/39/59 个广域 suite。

## 8. 证据局限

1. 这是静态源码审计，不声称外部部署均启用所有可选配置；A4 因此明确报告 58/59 两个值。
2. manifest/registry 是 schema 计数的事实源；README 的“支持某域”只用于能力说明，不用于补造数字。
3. `main`/`master` 会漂移；所有关键计数和大多数实现链接固定到核验 commit。A10 changelog 的补充链接用于确认功能发布，具体实现仍以固定 adapter 快照为准。
