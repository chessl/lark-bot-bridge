# 飞书统一 Reply 实现原语研究

> 结论先行：**公开、可核验且最贴合目标的基线，是“CardKit 2.0 卡片实体 + IM Reply API 定位 + CardKit 流式/局部/全量更新 + 显式关闭 streaming”**。`message_cot` 不应作为生产基线：公开 `llms.txt` 与消息目录没有它，公开文档路由不给出 API 规范，官方 Go SDK 也只暴露一个 AG2UI 事件数据模型，且把事件枚举链接到内部文档；权限、灰度、创建/完成语义、Topic 定位、限流和错误码均无法从公开一手资料确认。

## 1. 研究口径与证据等级

本文按官方文档的层级查找：飞书 [`llms.txt`](https://open.feishu.cn/llms.txt) → [消息目录](https://open.feishu.cn/llms-docs/zh-CN/llms-messaging.txt) / [飞书卡片目录](https://open.feishu.cn/llms-docs/zh-CN/llms-feishu-card.txt) → 单项 API/组件文档；同时交叉检查了 Lark 的 [`llms.txt`](https://open.larksuite.com/llms.txt) 与 [Messaging 目录](https://open.larksuite.com/llms-docs/en-US/llms-messaging.txt)，以及官方 [`larksuite/oapi-sdk-go`](https://github.com/larksuite/oapi-sdk-go) 源码。

标记含义：

- **已证实**：公开官方文档或官方源码明确写出。
- **可实现**：飞书只提供通用展示/更新原语，具体 Run 语义由本项目投影；不是飞书原生语义。
- **未知/租户检查**：公开一手资料不足，不能据此承诺生产行为。

“完整运行统计”在本文中是产品投影要求，不声称由飞书自动生成：至少包括总耗时、首字延迟、前置耗时、模型耗时、输入/输出 Token 和工具调用次数；上游拿不到的字段必须明确显示为不可得，不能伪造。票面五态按当前 UI 语义理解为 `running`、`done`、`interrupted`、`idle_timeout`、`error`；严格说 `running` 不是终态，后四项才是终态。

## 2. 候选矩阵

| 候选 | 普通 Chat 原生回复 | Topic 原生定位 | 单消息全生命周期 | Progress / 工具折叠 | Final 原位完成 | 五态 | 完整统计 | 无重复降级 | 结论 |
|---|---|---|---|---|---|---|---|---|---|
| `message_cot` | **未知**：公开规范缺失 | **未知**：`origin_message_id` 等放置规则无公开规范 | **未知** | **未知** | **未知**：公开资料不能核实 `complete` 的终态效果 | **未知**：公开 SDK 只有通用 AG2UI `event_type` | **未知** | **未知**：没有公开幂等字段/失败表 | **不采用基线**；只可做隔离灰度实验 |
| **CardKit streaming 实体 + IM Reply** | **已证实**：Reply 以目标 `message_id` 建立回复关系 | **已证实**：已在话题内的消息默认继续以话题形式回复；普通群消息可用 `reply_in_thread=true` 创建话题 | **已证实/可实现**：实体只发送一次，随后改同一实体 | **已证实/可实现**：JSON 2.0 有 `collapsible_panel`，运行中可改组件 | **已证实**：最终整卡/批量更新后显式 `streaming_mode=false` | **可实现**：卡片内容自行映射五态 | **可实现**：在 30 KB / 200 元素预算内展示 | **部分已证实**：Reply `uuid` 一小时内至多成功一条；CardKit 更新有 `uuid` + 严格递增 `sequence`。但首条消息已存在后再发另一条“降级消息”会破坏单消息约束 | **推荐** |
| CardKit 非流式实体 patch/update | **已证实**：同样可经 Reply 发送 | **已证实**：同上 | **已证实/可实现**：同一实体反复局部/全量更新 | **已证实/可实现**：可更新折叠面板及其他组件；没有打字机效果 | **可实现**：最终一次 update/batch update 即终态 | **可实现** | **可实现** | **较强**：更新有 `uuid`/`sequence`；同一实体不新增气泡 | **可靠备选**；不要求逐字流式时更简单 |
| 普通 interactive 消息 + `PATCH /im/v1/messages/:message_id` | **已证实**：先 Reply，后按 `message_id` 更新 | **已证实**：定位由 Reply 决定 | **已证实/可实现**：反复替换同一消息卡片 | **可实现**：可发送 Card JSON 2.0 折叠组件，但每次是整卡替换 | **可实现**：最后一次 PATCH 即终态；无独立 completion 协议 | **可实现** | **可实现** | **中等**：更新同一 `message_id` 不新增气泡，但 API 未公开 `uuid` 或顺序字段，并发覆盖规则未文档化 | **次选**；简单但并发/顺序保证弱 |

矩阵依据：IM Reply 明确支持 `interactive`，并返回 `root_id`、`parent_id`、`thread_id`；`reply_in_thread=true` 会以话题形式回复，若被回复消息已在话题中则默认继续话题，且 Reply 请求 `uuid` 相同后一小时内至多成功回复一条（内容变化时必须换 `uuid`）——见 [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。CardKit 卡实体 ID 是适用于局部/流式更新的 interactive 内容形式，而该内容结构明确适用于 Send、Reply、Edit 三个接口——见 [发送消息内容结构](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json)。CardKit 的流式、终结和继续改组件能力见 [流式更新指南](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)；普通消息卡片整卡替换规则见 [更新已发送的消息卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)。

## 3. 推荐方案的可靠生命周期

### 3.1 创建并原生定位

1. 用 Card JSON 2.0 创建卡片实体，初始 `config.streaming_mode=true`，为后续操作的组件设置全卡唯一 `element_id`。CardKit create 只支持 `schema: "2.0"` 或新版 CardKit 模板，不允许 `update_multi=false`；实体有效期 14 天且只能发送一次——见 [创建卡片实体](https://open.feishu.cn/document/cardkit-v1/card/create)。
2. 调用 `POST /open-apis/im/v1/messages/:message_id/reply`，`msg_type="interactive"`，`content` 使用 `{"type":"card","data":{"card_id":"..."}}`。Card entity 这种 content 形式被官方列为“需要局部更新或流式更新”的发送方式，而内容结构文档声明其示例适用于 Reply——见 [消息内容结构](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json) 与 [Reply API](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。
3. 普通 Chat 使用 `reply_in_thread=false`，得到原生引用回复；普通消息要新建话题时使用 `true`；目标消息已在话题内时 Reply 默认留在话题。`root_id`/`parent_id`/`thread_id` 是服务端返回的定位证据——见 [Reply API](https://open.feishu.cn/document/server-docs/im-v1/message/reply) 与 [话题概述](https://open.feishu.cn/document/im-v1/message/thread-introduction)。

这比先向 `chat_id` 发送普通卡再人工写“回复某某”可靠：定位关系由 IM Reply 资源建立，不由卡片正文模拟。

### 3.2 运行中更新

- 把模型累计文本的**全量值**写入 `PUT /cards/:card_id/elements/:element_id/content`。旧文本是新文本前缀时，客户端只对新增部分使用打字机效果；前缀不同则直接全量替换。接口只接受 `plain_text`/`markdown`，并要求 streaming 已开启——见 [流式更新文本](https://open.feishu.cn/document/cardkit-v1/card-element/content)。
- 工具状态、Progress、统计和布局变化用 element PATCH、整卡 PUT 或 batch update；除“流式更新文本”外，卡片/组件级 API 在 streaming 开或关时都能继续细粒度更新——见 [流式更新指南](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)、[更新组件属性](https://open.feishu.cn/document/cardkit-v1/card-element/patch)、[全量更新卡片实体](https://open.feishu.cn/document/cardkit-v1/card/update) 与 [批量更新卡片实体](https://open.feishu.cn/document/cardkit-v1/card/batch_update)。
- 只把 Agent 明确提供的安全 Progress 摘要和脱敏、截断后的工具摘要放入 `collapsible_panel`，不展示或推导原始思维链；运行中显式设 `expanded=true`，终结投影设为 `false`。该组件默认收起，可配置 `expanded`，但只能手写 Card JSON，CardKit 搭建工具尚不支持；容器最多嵌套五层且不能嵌入 `form`——组件能力见 [折叠面板 JSON 2.0](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel)。

### 3.3 Final 原位完成

建议将“终态内容更新”和“关闭 streaming”拆成同一串行 renderer 队列中的最后两步：

1. 用 batch update 或 full update 写入最终答案、五态中的对应状态、完整统计，并移除/收起运行中控件；CardKit update/batch update 支持调用方提供 `uuid`，且同一卡的 `sequence` 必须严格递增——见 [全量更新](https://open.feishu.cn/document/cardkit-v1/card/update) 与 [批量更新](https://open.feishu.cn/document/cardkit-v1/card/batch_update)。
2. `PATCH /cards/:card_id/settings` 设置 `streaming_mode=false`，同时更新最终 `summary.content`。官方建议手动关闭；若不关闭，最后一次激活 10 分钟后才会自动关闭，消息预览可能继续显示默认的“生成中”，而且 streaming 开启时卡片不能转发、交互回调也不能直接更新卡片——见 [流式更新指南](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview) 与 [更新卡片配置](https://open.feishu.cn/document/cardkit-v1/card/settings)。

“`done` / `interrupted` / `idle_timeout` / `error`”不是飞书内建 Run 枚举，而是本项目应投影到标题、颜色、正文和统计区的业务状态；CardKit 提供的是可更新结构，不提供 Agent Run 状态机，也没有把“写入终态内容”和“关闭 streaming”合成一个服务端 `complete` 原语。若第一步成功而关闭 streaming 失败，正文已是终态，但消息预览可能继续显示“生成中”直至最后一次激活 10 分钟后自动关闭，因此这两步必须串行、幂等重试。四个终态均关闭 streaming，且 Reply 内不提供终止按钮，才能得到一致的单气泡生命周期。

## 4. 权限、版本、限额与并发

### 4.1 权限与可用范围

- CardKit 卡片实体 API 要求 `tenant_access_token` 和 `cardkit:card:write`，公开资源总览标明自建应用与商店应用均支持——见 [飞书卡片资源概述](https://open.feishu.cn/document/cardkit-v1/feishu-card-resource-overview)。
- Reply 要开启机器人能力；应用身份发送可申请 `im:message`、`im:message:send_as_bot` 或历史 `im:message:send` 中任一项。单聊用户必须在机器人可用范围，群聊机器人必须在群内并有发言权——见 [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。
- CardKit create/update 要求创建、发送、操作卡片的是同一应用；CardKit create 不允许 exclusive card（`update_multi=false`）——见 [创建卡片实体](https://open.feishu.cn/document/cardkit-v1/card/create) 与 [全量更新卡片实体](https://open.feishu.cn/document/cardkit-v1/card/update)。
- 公开飞书文档没有给 CardKit 标注额外灰度门槛；但 Lark 全球站顶层目录没有“CardKit/飞书卡片”模块，Lark Messaging 目录也只列普通 message-card update，没有 CardKit entity API——见 [Lark `llms.txt`](https://open.larksuite.com/llms.txt) 与 [Lark Messaging](https://open.larksuite.com/llms-docs/en-US/llms-messaging.txt)。因此 **不能把中国飞书文档外推为所有 Lark 租户已开通**，全球租户必须 live check。

### 4.2 Schema 与客户端差异

- CardKit entity API 只支持 Card JSON 2.0/新版模板；create 若不是 `schema: "2.0"` 返回 `300303`——见 [创建卡片实体](https://open.feishu.cn/document/cardkit-v1/card/create)。
- JSON 2.0 内容要求飞书客户端 7.20+；低版本只正常显示标题，正文显示升级提示。7.20–7.22 使用默认的 streaming 频率/步长/策略，7.23+ 才支持自定义 `print_frequency_ms`、`print_step`、`print_strategy`；默认值还可能随平台、版本和设备变化——见 [流式更新指南](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)。
- `collapsible_panel.header.width` 只有客户端 7.32+ 支持；折叠面板本身只能手写 JSON——见 [折叠面板](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel)。

因此客户端验收至少要覆盖 PC/iOS/Android 的 7.20–7.22、7.23+ 和当前版本；低于 7.20 只能接受明确的升级降级展示，不能承诺完整 Reply 内容可读。

### 4.3 频率、顺序与并发

- CardKit 各 create/update/patch API 的接口级限制为 1000 次/分钟且 50 次/秒；单个卡片实体的卡片/组件操作另限 10 次/秒——见 [create](https://open.feishu.cn/document/cardkit-v1/card/create)、[element content](https://open.feishu.cn/document/cardkit-v1/card-element/content) 与 [流式指南](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)。
- CardKit 每次更新要求正 int32 `sequence`，对同一卡必须比前一次操作严格递增；`uuid` 最长 64 字符，可保证同一批操作只执行一次。乱序会返回 `300317`，UUID 冲突返回 `200770`——见 [全量更新](https://open.feishu.cn/document/cardkit-v1/card/update) 与 [组件 PATCH](https://open.feishu.cn/document/cardkit-v1/card-element/patch)。工程上应坚持“每 card 一个串行 writer”，不要让文本流、工具区和终结步骤各自维护 sequence。
- 同一卡处于交互处理中会返回 `200810`；streaming 模式下回调不能直接更新，必须先关闭 streaming 再处理交互——见 [组件 PATCH](https://open.feishu.cn/document/cardkit-v1/card-element/patch) 与 [流式指南](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)。
- Reply 对同一用户、同一群的发送限制均为 5 QPS，群的 5 QPS 由群内机器人共享；接口级限制仍是 1000 次/分钟、50 次/秒——见 [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。
- 普通消息卡片 PATCH 的单消息更新上限为 5 QPS，且公开请求体只有 `content`，没有 CardKit 的 `sequence`/`uuid`；并发覆盖规则未在该文档说明——见 [更新已发送的消息卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)。

### 4.4 内容与元素限制

- Reply 的卡片或富文本请求体不得超过 30 KB；模板实际数据也计入，样式标签会增大实际大小——见 [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。
- CardKit 生成后的卡片应保持在 30 KB 内，超限返回 `200860`；JSON 2.0 单卡最多 200 个元素/组件，超限返回 `300305`，重复 `element_id` 返回 `300301`——见 [创建卡片实体](https://open.feishu.cn/document/cardkit-v1/card/create)。create 的 `data` 字符串字段虽允许更大的请求值，也不解除最终 30 KB/200 元素限制。
- 折叠面板等容器最多嵌套五层——见 [折叠面板](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel)。

这意味着“完整统计”应固定占少量元素；原始思维链不得进入卡片，长工具摘要和历史 delta 则需要在 renderer 侧截断/汇总，不能把折叠视为突破大小限制的手段。

## 5. 失败语义与无重复降级

### 5.1 文档化失败

| 层 | 关键文档化失败 | 处置 |
|---|---|---|
| IM Reply | 机器人不在群 `230002`、原消息撤回 `230011`、用户不在可用范围 `230013`、群设置禁止 `230018`、话题不存在 `230019`、频控 `230020`、敏感信息/DLP `230022`/`230028`、超 30 KB `230025`、权限不足 `230027`、群不支持 thread `230071`、聚合消息不支持 thread `230072`、发送中 `230049` | 详见 [Reply 错误表](https://open.feishu.cn/document/server-docs/im-v1/message/reply)；只有确定未创建消息的前置失败才可切换不同内容的 fallback |
| CardKit entity | 实体不存在/过期 `200740`/`200750`、UUID 冲突 `200770`、交互中 `200810`、流式超时/关闭 `200850`/`300309`、超 30 KB `200860`、schema 错 `300303`、元素超 200 `300305`、应用非所有者 `300311`、sequence 乱序 `300317` | 详见 [流式文本错误表](https://open.feishu.cn/document/cardkit-v1/card-element/content) 与 [全量更新错误表](https://open.feishu.cn/document/cardkit-v1/card/update)；同一操作用同一 `uuid` 精确重试，所有更新串行化 |
| 普通 message-card PATCH | 已撤回 `230011`、频控 `230020`、超 30 KB `230025`、权限不足 `230027`、DLP `230028`、超过 14 天 `230031`、卡片生成失败 `230099`、已删除 `230110` | 详见 [普通卡片更新错误表](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)；只重试同一 `message_id` 的同一完整内容 |

CardKit 实体与普通 message-card 都只能在发送/创建后 14 天内更新——见 [创建卡片实体](https://open.feishu.cn/document/cardkit-v1/card/create) 与 [普通卡片更新](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)。这足够覆盖即时 Run，但不能被当作长期可编辑记录。

### 5.2 “无重复 fallback”的精确定义

**可以保证的部分：**

- 创建卡实体失败发生在首条 Reply 之前时，尚无消息气泡，可以改走普通 interactive/post/text Reply；仍应给 Reply 固定业务 `uuid`。Reply 文档承诺同一 `uuid` 一小时内至多成功回复一条——见 [Reply `uuid`](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。
- CardKit 首条 Reply 返回超时但服务端可能已提交时，只能用**相同 `uuid`、相同 card entity content**精确重试；换成不同内容必须换 UUID，官方明确要求“内容不同需更换 uuid”，因此此时切换到另一条文本 fallback **无法同时证明不重复**——见 [Reply `uuid` 说明](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。
- 已拿到 `message_id` 后，更新必须始终落到同一卡实体；CardKit 更新用同一操作 UUID 重试，并保持 sequence 单调。失败后另发一条“完成消息”会直接违反单消息生命周期，不应作为 fallback——见 [CardKit update 幂等与顺序字段](https://open.feishu.cn/document/cardkit-v1/card/update)。

因此推荐状态机是：`no_message` 阶段允许 CardKit → 普通 Reply 降级；`message_known` 阶段禁止创建第二气泡，只允许同卡精确重试/重建最终卡内容。若最终更新永久失败，记录 delivery failure 并保留最后成功投影；不要用第二条消息冒充“无重复降级”。

## 6. `message_cot`：已证实的只有什么

公开证据非常有限：

1. 飞书 [消息 `llms` 目录](https://open.feishu.cn/llms-docs/zh-CN/llms-messaging.txt) 和 Lark [Messaging 目录](https://open.larksuite.com/llms-docs/en-US/llms-messaging.txt) 都没有 `message_cot`；公开 `server-docs/im-v1/message_cot/create` 路由也没有可读取的 API 规范。因此无法从公开文档核实 endpoint、scope、应用类型、灰度条件、Chat/Topic 放置、完成 reason、频控、并发、幂等、内容总量、客户端版本或错误码。
2. 官方 Go SDK 的 [`MessageCot`](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/im/v1/model.go#L6115-L6160) 只定义 `event_type`、JSON 字符串 `content`（单事件最长 4096 字符）和毫秒 `timestamp`；注释称其为 AG2UI 事件，并把事件类型指向 `lark-oapi-tools-console.bytedance.net` 内部文档。公开 SDK 源码没有在这一模型附近给出可依赖的 create/update/complete API 契约。

所以，下列常见推断均应标为 **未知/租户专属**，而不是实现依据：`origin_message_id` 是否在 Topic 中继承位置、`complete(reason)` 是否原位完成、哪些 AG2UI 事件映射折叠区、是否原生支持五态/完整 usage、创建超时是否幂等、完成失败后客户端是否自动收口。即使某个租户实测可用，也只能形成带租户/应用/客户端版本的灰度能力标记，不能替代公开基线。

## 7. 最小 live checks

上线前只做以下最小、可判定检查；每项保存租户、应用类型、客户端平台/版本、请求 `log_id` 与实际 message/root/parent/thread/card ID：

1. **权限与门禁**：在目标飞书租户分别调用 CardKit create、IM Reply、element content、batch/full update、settings；确认 `cardkit:card:write` 与 IM 发送权限生效。若产品支持国际 Lark，必须在 Lark 租户单独跑同组检查，不能沿用飞书结论。
2. **普通 Chat 定位**：对普通群消息和单聊消息分别 Reply CardKit entity，核对唯一气泡、原生引用 UI、`parent_id`/`root_id`，且更新后关系不变。
3. **Topic 定位**：至少覆盖“回复 Topic 根消息”“回复 Topic 内子消息”“普通群消息 + `reply_in_thread=true`”三种输入，核对 `thread_id` 和客户端实际落点；特别确认根消息与子消息行为没有产品侧误解。
4. **流式与并发**：一个 writer 以 5–10 次/秒以内发送累计全文；再故意并发发送相同 sequence、乱序 sequence、相同 UUID，确认 `300317`/幂等行为以及恢复后的下一 sequence。
5. **终结**：对 `done`、`interrupted`、`idle_timeout`、`error` 四种终态分别写最终答案、完整目标统计并关闭 streaming；确认消息预览不再显示“生成中”、卡片可转发，且 Reply 内没有终止按钮。另验 `running` 的展开 Progress 与工具区。
6. **折叠与客户端**：PC/iOS/Android 至少各一台当前版；如仍支持旧版，再覆盖 7.20–7.22、7.23+ 和 <7.20 的明确降级。检查折叠默认值、更新后折叠内容、五层容器与 7.32 前后 `header.width`。
7. **边界**：用接近/超过 30 KB、200/201 元素、重复 element ID 的卡验证服务端错误；确认统计区始终保留，超额内容由应用侧截断而不是整体丢卡。
8. **故障与去重**：注入 CardKit create 响应超时、Reply 提交后响应超时、stream update 响应超时和 complete/settings 失败。验证首条 Reply 只用固定 UUID 精确重试；拿到 message ID 后绝不发第二条 fallback；同卡更新以 UUID/sequence 重试并最终只有一个气泡。
9. **COT 隔离探针（非上线前置）**：只有目标租户明确开通时，才记录 create/update/complete 的真实 scope、schema、错误码、Chat/Topic 落点、五态、统计、完成后的客户端效果与超时幂等。任何一项没有可重复证据，就保持 feature flag 关闭。

## 8. 最终建议

采用单一 adapter：

```text
CardKit create(schema 2.0, streaming=true)
  → IM Reply(message_id, interactive card_id, stable reply uuid)
  → serialized CardKit updates(uuid + strictly increasing sequence)
  → final batch/full update(answer + state + metrics)
  → settings(streaming=false, final summary)
```

把 `message_id`、`card_id`、下一个 `sequence`、最后成功投影和 Reply/更新 UUID 持久化；每张卡只允许一个 renderer writer。CardKit 非流式 update 是同一 adapter 的降级模式；普通 message-card PATCH 仅作为不需要打字机效果、也不需要 CardKit 顺序协议时的次选。`message_cot` 保持实验 feature flag，直到公开规范或目标租户的完整 live evidence 同时覆盖权限、灰度、Topic、完成、五态、统计、限流、客户端与故障幂等。
