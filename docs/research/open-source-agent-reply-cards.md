# 开源 Agent Reply 卡片实现调查

- 调查日期：2026-08-23
- 问题：是否已有可核实的开源 Lark/Feishu Agent 实现了“一条持续更新的 Reply”，并同时覆盖运行状态标题、可折叠进度、逐次工具摘要、最终答案、运行统计、Topic/引用定位、更新合并、终态切换与失败降级？
- 证据标准：只采纳固定 commit 的仓库源码、版本清单和许可证；README 仅用于项目定位，行为以代码为准。截图、移动分支链接和未落到源码的说明不作为实现证据。

## 结论

有两个足够接近、且源码可核实的实现：

1. **`larksuite/openclaw-lark` 是最适合借鉴的 TypeScript 基线**。它使用 CardKit 卡片实体和 JSON 2.0 schema，在同一 Reply 中流式更新正文，维护工具调用步骤，完成时关闭 streaming mode 并整卡替换，支持引用/Topic、双层降级和终态状态机。它由 Lark/Feishu Open Platform 团队维护，MIT 许可；但事件入口、session metrics 和 dispatcher 依赖 OpenClaw plugin runtime，不能直接移植。
2. **`baileyh8/hermes-feishu-streaming-card` 与目标视觉和信息结构最接近**。它明确建模 `thinking.delta`、`answer.delta`、`tool.updated`、`message.completed/failed`，用 schema 2.0 卡片渲染运行中 header、折叠 timeline、逐工具详情、最终正文和 footer，并通过同一消息的 IM `PATCH` 更新。它也是 MIT；但它是 Python/Hermes sidecar，并通过 Hermes hook/patch 接事件，集成层不兼容本项目。

`huoxue1/harness-lark` 是更小的 TypeScript 参考：单卡、状态 header、折叠 reasoning、footer、Topic reply 和 1.2 秒节流都存在，但没有逐工具 timeline，使用旧式 IM message card + `im.message.patch`，且卡片创建失败后的静态降级在当前调用路径中未闭环。`kid0317/xiaopow` 只有“Loading 卡 → 最终整卡替换”，README 所称“PATCH 失败重发”与源码不符，且检查的 commit 没有许可证文件或 package license 字段，不应复制。

因此，不需要从零发明卡片结构。推荐组合是：**借 OpenClaw 的 TypeScript 状态机、CardKit API 封装、sequence/节流和降级边界；借 Hermes sidecar 的事件归约、单轮 timeline/工具摘要和 `delivered | not_sent | unknown` 语义；不要复制两者的 Agent-runtime 接线。**

## 覆盖矩阵

| 能力 | OpenClaw Lark | Hermes Feishu Card | harness-lark | XiaoPaw |
|---|---|---|---|---|
| 一条可更新 Reply | 是，CardKit entity + 单条 IM message | 是，单条 interactive message 持续 `PATCH` | 是，单条 interactive message 持续 `patch` | 仅 Loading → final 一次替换 |
| 运行状态 header | Thinking / Generating / Complete / Error | 运行工具摘要、等待、完成、失败 | Thinking / Generating / Complete / Error | 无 header，仅正文 Loading 文案 |
| 可折叠进度 | reasoning + tool-use panels | auxiliary timeline | reasoning panel | 无 |
| 逐次工具摘要 | 是，结构化 trace step | 是，按 tool id 归约 | 否 | 否；verbose 是额外消息路径 |
| 最终答案 | 是 | 是 | 是 | 是 |
| 运行统计 | elapsed/model/token/cache/context | duration/model/input/output/context/tool count 等 | elapsed/model/token/cache/context | 无卡片 footer |
| 引用 / Topic | `replyToMessageId` + `reply_in_thread` | Reply API + `reply_in_thread`，后续 PATCH 原消息 | 同 OpenClaw 的 IM Reply 方式 | thread 走 Reply API |
| 更新合并 | CardKit 100ms；IM fallback 1500ms；互斥 reflush | latest-wins controller，可配置 interval，终态 drain | 固定 1200ms，互斥 reflush | 无流式更新合并 |
| 明确终态 | completed/aborted/terminated/creation_failed | completed/failed + terminal drain | complete/error | final 或 worker error |
| 降级 | CardKit → IM card → static text；表格超限转文本 | 发送结果三态、稳定 UUID 重试、卡片超限原生接管 | 代码仅标记 creation error，静态降级未接上 | 仅初始卡发送失败时 final `send`；PATCH 失败不重发 |
| 可直接复用性 | 高（MIT/TS），但需切断 OpenClaw runtime | 中（MIT/Python），适合借模型与策略 | 中（MIT/TS），适合借小型 renderer | 低（无明确许可、行为缺口） |

## 1. `larksuite/openclaw-lark`: 最完整的 TypeScript/CardKit 参考

### 仓库、版本和许可

调查固定在 commit [`dde0be3680d6fd5443cab426c8f4b3216266346a`](https://github.com/larksuite/openclaw-lark/tree/dde0be3680d6fd5443cab426c8f4b3216266346a)。README 将其描述为 Lark/Feishu Open Platform 团队维护的 OpenClaw 官方插件；[`package.json`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/package.json) 标记版本 `2026.7.9`、Node `>=22`、`@larksuiteoapi/node-sdk ^1.64.0` 和 OpenClaw peer dependency `>=2026.5.4`。根 [`LICENSE`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/LICENSE) 是 MIT（Copyright 2026 Lark Technologies Pte. Ltd.）。

版本注意：README 的最低 OpenClaw 版本文字仍写 `2026.2.26`，但 package peer dependency 已是 `>=2026.5.4`；集成时应以 package 约束为准，而不是复制 README 的旧下限。

### 实际 API 和消息定位

[`src/card/cardkit.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/cardkit.ts) 给出了完整 CardKit 链路：

1. `client.cardkit.v1.card.create` 创建 `type: "card_json"` 的卡片实体，取得 `card_id`。
2. 通过 `client.im.message.reply` 或 `client.im.message.create` 发送 `msg_type: "interactive"`，`content` 是 `{"type":"card","data":{"card_id":"…"}}`。有原消息时携带 `reply_in_thread`，因此同一实现同时覆盖普通引用 Reply 和 Topic 内 Reply。
3. 流式正文调用 `client.cardkit.v1.cardElement.content`，路径为 `card_id + element_id`，请求携带**完整累计正文**和单调递增 `sequence`，不是发送 delta。
4. 终态先调用 `client.cardkit.v1.card.settings` 写 `{"streaming_mode": false}`，再调用 `client.cardkit.v1.card.update` 以更高 sequence 替换完整终态卡。

这不是旧的“反复 PATCH 整条 IM message”模拟流式；CardKit entity 与承载它的 IM message 是两个对象，IM message 只创建一次。

### schema、状态、进度和统计

[`src/card/builder.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/builder.ts#L647-L771) 的 `toCardKit2` 产生 `schema: "2.0"`，把旧 builder 的 `elements` 放进 `body.elements`。同一文件定义：

- Thinking / Streaming / Complete / Confirm 状态 header；
- `collapsible_panel` reasoning 区；
- `collapsible_panel` 工具区；
- 正文 markdown element；
- status、elapsed、model、input/output/cache/context 等 footer 字段。

工具摘要不是从模型正文猜出来的。[`tool-use-trace-store.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/tool-use-trace-store.ts) 为每次调用保存 `toolCallId/runId/params/result/error/duration/status`，限制每 session 256 步、30 分钟 TTL，并在展示前截断和脱敏；[`tool-use-display.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/tool-use-display.ts) 再把 read/edit/search/bash/browser/sub-agent 等归一成标题、摘要、状态、可选 result/error block。这个“结构化事件存储 → 安全归一 → 卡片元素”的分层可以直接借鉴。

### 事件合并和终态

[`reply-dispatcher-types.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/reply-dispatcher-types.ts) 定义显式状态机：`idle → creating → streaming → completed/aborted/terminated`，另有 `creation_failed`；终态不可再迁移。节流常量区分 CardKit `100ms`、IM patch `1500ms`、长间隙后的 `300ms` batching，以及工具状态 `1500ms`。

[`flush-controller.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/flush-controller.ts) 用单一 in-flight flush、`needsReflush` 和 pending timer 合并并发更新；事件在 API 调用期间到达时只触发一次紧随其后的 reflush。终态会取消 timer 并等待正在执行的 flush。

[`streaming-card-controller.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/streaming-card-controller.ts#L654-L749) 的正常完成顺序是：等待 flush → 等待 card creation → 关闭 streaming mode → 解析最终正文/图片/工具步骤/metrics → 以新 sequence 更新终态卡。错误和 abort 走同一“close streaming then update”边界，而不是仅修改内存状态。

### 降级边界

这里的 fallback 是源码闭环，不只是注释：

- CardKit create/send 失败后，[controller](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/streaming-card-controller.ts#L915-L962) 先退到普通 interactive IM card；若这也失败，进入 `creation_failed`。
- [`reply-dispatcher.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/reply-dispatcher.ts#L223-L305) 检测不到 `cardMessageId` 时继续静态发送；Markdown 卡因表格限制 `230099/11310` 被拒后，再退到 text message。
- 空回复使用显式 `Done.`，源消息被删除/撤回则由 unavailable guard 终止后续更新，避免不断重试不可用 message。

### 可借与不可照搬

**可借：** CardKit wrapper；JSON 2.0 renderer；sequence 单调递增；CardKit/IM 两档节流；单 in-flight + reflush；结构化 tool trace；终态先关 streaming mode 再整卡更新；CardKit → IM card → text 的降级阶梯。

**不可照搬：** `ReplyPayload`、`LarkClient.runtime`、OpenClaw session store、reply dispatcher hooks 和 tool trace 注入都属于 OpenClaw runtime。尤其 footer metrics 读取包含 OpenClaw session-key round-trip workaround，移植到本项目会引入错误耦合。应保留卡片控制器接口，换成本项目自己的 Agent event adapter。

## 2. `baileyh8/hermes-feishu-streaming-card`: 与目标 UI/信息结构最接近

### 仓库、版本和许可

调查固定在 commit [`c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0`](https://github.com/baileyh8/hermes-feishu-streaming-card/tree/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0)。[`pyproject.toml`](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/pyproject.toml) 给出版本 `4.3.2`、Python `>=3.9`、依赖 `aiohttp>=3.9` 和 `PyYAML>=6.0`；[`LICENSE`](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/LICENSE) 是 MIT。

它是 Hermes Gateway 的 sidecar 插件，不是通用 Lark SDK。仓库 active runtime 在 `hermes_feishu_card/`，README 明确说明旧 V2 放在 `legacy/`；不能把 legacy 代码当成当前实现。

### 事件模型和单卡归约

[`events.py`](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/hermes_feishu_card/events.py) 只接受明确事件集合：`message.started`、`thinking.delta`、`answer.delta`、`tool.updated`、`message.completed`、`message.failed`、`system.notice`、interaction 和 subagent 事件。

[`session.py`](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/hermes_feishu_card/session.py#L97-L145) 的 `CardSession` 同时保存 answer/thinking、工具表、token/model/context/duration、Reply anchor 和 timeline。`apply()` 以 sequence 拒绝陈旧的非终态事件，但允许终态越过顺序栅栏；[`tool.updated` 处理](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/hermes_feishu_card/session.py#L235-L294) 按 tool id 更新原步骤，并只在新调用或前一调用已终态时增加调用数。`message.completed/failed` 收束 timeline 并切状态。

[`card_timeline.py`](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/hermes_feishu_card/card_timeline.py) 分别索引 reasoning/tool/notice/subagent；同一 tool id 原位更新，终态步骤不会被后到事件改写，`snapshot(max_items)` 负责折叠旧步骤。这个 reducer 比直接把工具日志拼成 markdown 更可靠。

### schema 和可见结构

[`render.py`](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/hermes_feishu_card/render.py#L309-L335) 直接生成 `schema: "2.0"`、`config.update_multi: true` 的卡；主内容使用 markdown element，辅助过程使用 `element_id: "auxiliary_timeline"` 的 `collapsible_panel`（[`render.py`](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/hermes_feishu_card/render.py#L1141-L1165)）。运行时 header subtitle 来自当前 tool preview；终态 Reply 可移除多余自定义 header，保留原生引用关系。默认 footer 是 duration、model、input tokens、output tokens、context，工具详情可含脱敏后的参数、耗时和失败原因。

与 OpenClaw 不同，它没有 CardKit entity；它把 JSON 2.0 card 作为 interactive message content，持续更新整条消息。

### 实际 IM API、Topic 和投递语义

[`feishu_client.py`](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/hermes_feishu_card/feishu_client.py#L198-L277) 直接调用：

- 初次 Reply：`POST /im/v1/messages/{reply_to_message_id}/reply`，body 包含 `msg_type: interactive`、序列化 card、`reply_in_thread: bool(thread_id)` 和稳定 UUID；
- 非 Reply：`POST /im/v1/messages?receive_id_type=chat_id|thread_id`；
- 后续更新：`PATCH /im/v1/messages/{message_id}`，只传新的 `content`。

稳定 UUID 由 bot/chat/reply/session/delivery kind 哈希得到；仅在 UUID 可用时对初次 send 做最多三次有界重试。错误结果区分 `not_sent` 和 `unknown`：HTTP 429/502/503/504、超时、网络错误或无法解析的响应可能是 `unknown`，不能盲目补发原文，否则可能造成重复 Reply。这一三态比简单 boolean 更值得移植。

### batching、终态和 fallback

[`flush.py`](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/hermes_feishu_card/flush.py) 是 latest-wins controller：同一时间只保留最新 render callback，把等待队列压为一个 pending 更新；terminal schedule 跳过普通 interval，`drain()` 有超时指标。[`server.py`](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/hermes_feishu_card/server.py) 在终态先 drain，再以 `terminal=True` 调度最终 render、关闭 controller 并做 session 清理。

[`render_card_result`](https://github.com/baileyh8/hermes-feishu-streaming-card/blob/c3e634ad7ef310d2907ae0199f0b6bc6e6a0efe0/hermes_feishu_card/render.py#L129-L182) 在发卡前检查平台限制；运行中超限标为 `deferred_native`，终态超限标为 `native`，并渲染接管提示，而不是发送半截卡。加上初次投递的三态，fallback 决策是：确定未发送才原文降级；结果未知只提示，不重复发送；确定已发送则继续 PATCH 同一 message。

### 可借与不可照搬

**可借：** 事件 schema；`CardSession.apply` reducer；按 tool call id 原位更新；timeline 截断；运行状态 header summary；投递三态；稳定 UUID；终态 drain；先检查 card size/table limits 再决定原生接管。

**不可照搬：** Hermes hook runtime、安装器对 `gateway/run.py` / `gateway/platforms/base.py` 的 patch、sidecar HTTP/HMAC、Hermes 版本 anchor 和 Python server 生命周期。那些是为无法直接控制 Hermes Gateway 而存在；本项目已经拥有 runtime，不应复制 sidecar 和源码 patch 复杂度。

## 3. `huoxue1/harness-lark`: 小型旧 IM-card 参考，有明确缺口

调查固定在 commit [`dc51752c796b7ec6164f64c03435c0f1975b5f07`](https://github.com/huoxue1/harness-lark/tree/dc51752c796b7ec6164f64c03435c0f1975b5f07)。[`package.json`](https://github.com/huoxue1/harness-lark/blob/dc51752c796b7ec6164f64c03435c0f1975b5f07/package.json) 是 `0.1.20`、MIT、Node 生态，依赖 `@larksuiteoapi/node-sdk ^1.64.0` 和多个 DeepSeek Harness `0.1.0-rc` peer；根 [`LICENSE`](https://github.com/huoxue1/harness-lark/blob/dc51752c796b7ec6164f64c03435c0f1975b5f07/LICENSE) 是 MIT。源码注释说明 card/flush/delivery 从 MIT 的 `openclaw-lark` 裁剪而来，并明确去掉 CardKit 2.0 tooling。

[`streaming-card.ts`](https://github.com/huoxue1/harness-lark/blob/dc51752c796b7ec6164f64c03435c0f1975b5f07/src/card/streaming-card.ts) 管理 `thinking → streaming → complete/error`；reasoning 和 answer 分 buffer，固定 `1200ms` patch 节流，完成时取消 pending flush、等待 in-flight、再整卡更新。[`builder.ts`](https://github.com/huoxue1/harness-lark/blob/dc51752c796b7ec6164f64c03435c0f1975b5f07/src/card/builder.ts) 使用旧式顶层 `config/header/elements` schema，完成卡有折叠 reasoning 和 elapsed/model/token/cache/context footer，但没有 tool-step 类型或工具 timeline。

[`deliver.ts`](https://github.com/huoxue1/harness-lark/blob/dc51752c796b7ec6164f64c03435c0f1975b5f07/src/messaging/outbound/deliver.ts#L65-L121) 使用 `client.im.message.reply/create` 发 interactive card，Reply 可设 `reply_in_thread`，更新使用 `client.im.message.patch`。 [`agent/bridge.ts`](https://github.com/huoxue1/harness-lark/blob/dc51752c796b7ec6164f64c03435c0f1975b5f07/src/agent/bridge.ts#L498-L569) 把 `assistant/chunk` 的 reasoning/text/usage 喂给卡片，在 `turn/end` 上 finish/fail。

关键缺口：`StreamingCard.start()` 失败时只把 phase 设为 `error` 并写注释“later static fallback”；`AgentBridge` 异步 `void card.start()` 后没有检查 `card.active`，streaming 模式的最终 `assistant/message` 也不会走 static `sendText`。因此当前源码没有证明创建失败后会真正发送最终答案。可借 renderer 和 throttle，不应复制它的 fallback 控制流，也不能把它当作逐工具进度实现。

## 4. `kid0317/xiaopow`: 只作为反例，不建议复用

调查固定在 commit [`66234ad986756e3aefcf64d92e92df3c76a62e6c`](https://github.com/kid0317/xiaopow/tree/66234ad986756e3aefcf64d92e92df3c76a62e6c)。[`pyproject.toml`](https://github.com/kid0317/xiaopow/blob/66234ad986756e3aefcf64d92e92df3c76a62e6c/pyproject.toml) 标记 `0.1.0` 和 Python `>=3.12`，但没有 license 字段；该 commit 的根目录没有 `LICENSE`/`LICENSE.md`，README 也没有许可声明。公开可读不等于获准复制，故其代码不进入可复用候选。

源码实现也远离目标：[`sender.py`](https://github.com/kid0317/xiaopow/blob/66234ad986756e3aefcf64d92e92df3c76a62e6c/xiaopaw/feishu/sender.py#L66-L130) 的卡片只有 `config.wide_screen_mode` 和一个 `div/lark_md`；`send_thinking()` 发“思考中”，`update_card()` 用 `PatchMessageRequest` 整体替换为最终文字。没有 header、折叠 panel、工具步骤或 footer。

README 声称“若更新失败，降级调用 `send()` 重新发送整条消息”，但 [`runner.py`](https://github.com/kid0317/xiaopow/blob/66234ad986756e3aefcf64d92e92df3c76a62e6c/xiaopaw/runner.py#L187-L214) 的真实分支只是：有 `card_msg_id` 就直接 `await update_card`，只有**初始 Loading 卡未拿到 id**才 `send`。PATCH 异常会冒到 worker 的总 catch，发送通用错误文案，不会重发最终答案。因此该 README 行为被拒绝。

## 推荐给本项目的最小设计切片

1. **Transport seam**：定义 `createReplyCard(anchor) -> {messageId, cardId?, mode}`、`updateElement/fullCard`、`finalize`，实现 CardKit 主路径；保留普通 IM card 和 text fallback。不要让 Agent adapter 直接调用 SDK。
2. **Turn reducer**：用稳定 turn id 聚合 `started/reasoning/tool/answer/completed/failed`；工具必须有 call id，后到终态事件可越过普通 sequence fence，但终态后禁止非终态改写。
3. **Render model**：`status header + answer lane + collapsed progress/tool lane + footer`。工具参数/result 先结构化截断和脱敏，再交给 renderer；不要渲染原始日志。
4. **Scheduler**：每 turn 最多一个 in-flight update；CardKit 使用约 100ms，IM patch 使用约 1500ms；API in-flight 期间的新事件只设置一次 reflush。终态取消 timer、等待当前 flush、关闭 streaming mode、最后整卡替换。
5. **Placement**：首卡始终 Reply 原入站 message；只有 Topic 场景设 `reply_in_thread: true`。缓存的是新卡的 message/card id，后续不再重新 Reply。
6. **Fallback**：CardKit create/send 失败 → 普通 interactive card；普通卡创建失败 → static text；卡已创建后的 update 失败不要新建重复 Reply。初次发送结果必须至少区分 `delivered/not_sent/unknown`，只有 `not_sent` 可安全补发。
7. **兼容约束**：CardKit 路径需要 `@larksuiteoapi/node-sdk` 覆盖 `cardkit.v1.card/cardElement` API；若当前锁定版本无该 surface，应显式选择 direct REST 或普通 IM patch，而不是类型断言伪装支持。不要同时引入 OpenClaw、Hermes 或 DeepSeek Harness runtime。

## 最终判断

- **存在足够接近的公开实现，不是 screenshot-only。** OpenClaw 提供最可信的 TypeScript/CardKit 生命周期；Hermes sidecar 提供最接近目标的一卡式 Agent timeline 和投递语义。
- **没有一个仓库能原封不动移入本项目。** 两个完整实现都把一部分关键行为绑定在各自 Agent runtime；安全复用单元应是 card transport、turn reducer、renderer、flush controller 和 fallback policy，而非整套插件。
- **优先级建议：** 先验证本项目当前 Lark SDK 是否有 CardKit API；有则采用 OpenClaw API 形状，无则先用同一 renderer + IM patch，但保留 transport seam，避免把 legacy IM 更新方式固化进 Agent 状态机。
