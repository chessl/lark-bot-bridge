# Mention 与个人替身参考设计研究

研究对象与固定版本：

- `lark-bot-bridge`：[`872aae3`](https://github.com/chessl/lark-bot-bridge/tree/872aae39ad8e0ae52c171f07e282bc6d525da21b)
- `cc-connect`：[`3727b74`](https://github.com/chenhg5/cc-connect/tree/3727b7402bd18cfac857629e37d3493323071747)
- `botmux`：[`085a3df`](https://github.com/deepcoldy/botmux/tree/085a3df6b38b90028f994ac9dd5cae7c58652a74)

下文先记源码事实，再给 `lark-bot-bridge` 的最小建议；不建议修改另外两个仓库。

## 结论

`cc-connect` 最值得借的是一个很窄的发送边界：显式 `alias → app-scoped open_id` 配置优先于成员名解析，最长名称先匹配，存在真实 `<at>` 时强制使用能触发 Mention 事件的文本消息。`botmux` 最值得借的是替身入口的安全形状：只认真人当场发送的 `text/post` 结构化 Mention、配置身份与事件身份分开、失败时不触发，并把本轮回复锚点冻结到触发消息。

`lark-bot-bridge` 不需要引入 `cc-connect` 的 RelayManager、项目绑定与专用 relay session，也不需要 `botmux` 的多 daemon bot 注册表、跨 app 身份学习、团队授权、Dashboard 代理、控制卡或运行态开关。现有的访问门、chat/topic scope、单个 OMP Reply controller、结构化 `bridge_context` 和 Profile 配置页已经是足够的落点。

## 源码事实对照

### 1. 群聊触发与回复寻址

**lark-bot-bridge**

- 入站先按 DM/群访问策略判定，再按全局或 per-chat `requireMention` 判定；严格模式下未 `mentionedBot` 的群消息直接丢弃。[`channel.ts#L703-L737`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/bot/channel.ts#L703-L737) [`access.ts#L47-L64`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/policy/access.ts#L47-L64)
- topic 用 `chatId:threadId` 隔离 session；事件携带的 `threadId` 比 chat-mode 缓存更权威。[`channel.ts#L660-L690`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/bot/channel.ts#L660-L690)
- 每次 run 在启动前把最后一条消息冻结成 Reply target；有 `threadId` 时 `reply_in_thread=true`，否则 quote-reply 触发消息但不新建 topic。[`channel.ts#L818-L824`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/bot/channel.ts#L818-L824) [`omp-reply-controller.ts#L18-L47`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/bot/omp-reply-controller.ts#L18-L47) [`omp-reply-controller.ts#L251-L266`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/bot/omp-reply-controller.ts#L251-L266)

**cc-connect**

- `group_reply_all`/`require_mention=false` 决定群消息是否必须 @bot；`thread_isolation` 决定 session key 是否为 `platform:chat:root:<id>`。[`feishu.go#L301-L317`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L301-L317) [`feishu.go#L1382-L1405`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L1382-L1405) [`feishu.go#L3611-L3627`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L3611-L3627)
- 默认有 message ID 就调用 Reply；`thread_isolation` 只决定 `reply_in_thread`，`reply_to_trigger=false` 才退化为 Create。[`feishu.go#L2809-L2840`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L2809-L2840) [`feishu.go#L3641-L3688`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L3641-L3688)

**botmux**

- 普通群替身触发进入既有 chat-scope session，但把 `replyRootId` 固定为本次触发消息；话题群保持原 thread-scope。[`event-dispatcher.ts#L3528-L3549`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/im/lark/event-dispatcher.ts#L3528-L3549)
- reply target 按 turn 存储并限量，chat-scope 可选 thread/quote，thread-scope 不携带替身的 chat-only 路由标记，避免并发回合串锚点。[`reply-target.ts#L261-L339`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/core/reply-target.ts#L261-L339)

### 2. Agent 正文别名转真实 Mention

**lark-bot-bridge**

- 当前只把结构化 mentions 注入 `bridge_context`，并在 system prompt 里要求 agent 需要交接时使用真实 open_id；发送路径没有 `@别名 → <at>` 转换器。[`channel.ts#L1235-L1259`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/bot/channel.ts#L1235-L1259) [`bridge-system-prompt.ts#L18-L31`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/agent/bridge-system-prompt.ts#L18-L31)
- OMP Reply 当前只发 `interactive`/`post`，而非 mention 事件所需的 text lane。[`omp-reply-controller.ts#L251-L266`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/bot/omp-reply-controller.ts#L251-L266)

**cc-connect**

- `mention_map` 是显式 friendly name → open_id；它覆盖群成员同名结果，并要求同时开启 `resolve_mentions`。[`config.example.toml#L1035-L1043`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/config.example.toml#L1035-L1043) [`feishu.go#L329-L343`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L329-L343)
- 发送前合并成员表和显式表，显式表后写入所以优先；名称按长度降序，随后将全部 `@name` 替换为 `<at user_id="openId">name</at>`。[`feishu.go#L1938-L1990`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L1938-L1990)
- 发现真实 at tag 后强制 `MsgTypeText`，因为 card/post 不会向目标 bot 产生 Mention 事件；测试固定了显式配置优先和最长匹配。[`feishu.go#L3090-L3109`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L3090-L3109) [`feishu_test.go#L1418-L1447`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu_test.go#L1418-L1447)

**botmux**

- 模型可用 `--mention open_id:name` 登记本次名称映射；纯函数按最长名称、Unicode 后边界、ASCII 前边界把正文 `@Name` 改成 `<at id=open_id></at>`，并返回已内联 ID 以避免 footer 重复 @。[`inline-mentions.ts#L1-L29`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/im/lark/inline-mentions.ts#L1-L29) [`inline-mentions.ts#L43-L74`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/im/lark/inline-mentions.ts#L43-L74)
- 正文 `@BotName` 还会从本地 bot 清单发现候选，但只使用发送方 app 视角的 cross-ref open_id；缺失时告警并跳过，不回退到目标 bot 自己视角的错误 ID。代码块内名字、self alias、同类型但不在当前会话的泛化 alias 都被排除。[`cli.ts#L10319-L10405`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/cli.ts#L10319-L10405) [`dispatch.ts#L680-L713`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/core/dispatch.ts#L680-L713)

### 3. 跨 Bot 身份、信任与循环

**lark-bot-bridge**

- 从 raw `sender_type` 区分 user/bot，把本 bot open_id、发送者类型和结构化 mentions 注入 context；缺失类型时不猜。[`channel.ts#L1263-L1280`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/bot/channel.ts#L1263-L1280) [`bot-at-bot-context.test.ts#L83-L153`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/tests/integration/bot/bot-at-bot-context.test.ts#L83-L153)
- 群访问是 chat 级门，不单独 vet bot sender；循环控制目前是 system prompt 约定：默认不 @ 其他 bot、没有新信息就收尾。[`access.ts#L47-L57`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/policy/access.ts#L47-L57) [`bridge-system-prompt.ts#L27-L31`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/agent/bridge-system-prompt.ts#L27-L31)

**cc-connect**

- `peer_bots` 只把 quoted reply 中 Feishu `sender_type=app` 的 app_id 映射为友好名；未知 bot 明示为 `Bot[app_id]`。这是归因，不是授权门。[`feishu.go#L320-L327`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L320-L327) [`feishu.go#L2050-L2062`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L2050-L2062) [`feishu.go#L2186-L2209`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L2186-L2209)
- 另一条跨 bot 路径是进程内 `RelayManager`：持久化 chat→project 绑定、只允许 bound target、调用目标 engine，并可把请求/响应显式回显到群里。[`relay.go#L23-L51`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/core/relay.go#L23-L51) [`relay.go#L204-L268`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/core/relay.go#L204-L268)
- relay 为每个 source project/platform/chat 建专用 agent session，并在 system prompt 暴露 `cc-connect relay send`；源码没有 hop-count 型循环闸，主要约束来自显式 target/binding 和超时。[`engine.go#L15669-L15718`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/core/engine.go#L15669-L15718) [`interfaces.go#L205-L216`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/core/interfaces.go#L205-L216)

**botmux**

- Lark open_id 按 app 作用域，botmux 从每个接收 app 看到的 Mention 事件学习 `botName → receiver-scoped open_id`；cross-ref 命中可作为普通协作 peer 识别。[`event-dispatcher.ts#L948-L975`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/im/lark/event-dispatcher.ts#L948-L975)
- bot sender 与 human sender 在入口即分支。self echo 除 `/close` 外全部吞掉；外部 bot 必须明确 @ 本 bot，并通过统一 bot talk 门。冷启动 sibling 只在 live `/members/bots`、唯一配置名和对方 `is_in_chat` 三组信号一致时通过，否则失败关闭并走 grant。[`event-dispatcher.ts#L3101-L3143`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/im/lark/event-dispatcher.ts#L3101-L3143) [`event-dispatcher.ts#L3325-L3375`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/im/lark/event-dispatcher.ts#L3325-L3375) [`client.ts#L2048-L2124`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/im/lark/client.ts#L2048-L2124)
- 出站 `--no-mention` 会跳过 alias 扫描；默认 footer 不允许隐式唤醒 bot，明确 bot handoff 时还会去掉默认 owner courtesy ping。人类需要抄送必须显式选择。[`cli.ts#L10329-L10342`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/cli.ts#L10329-L10342) [`bot-routing.ts#L125-L170`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/utils/bot-routing.ts#L125-L170)

### 4. 替身目标配置与解析

**lark-bot-bridge / cc-connect**

- 两者当前都没有“@某人即由 bot 代答”的替身配置。`cc-connect` 的 `mention_map` 只解决**出站** bot Mention，不能当替身目标表使用。[`config.example.toml#L1035-L1043`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/config.example.toml#L1035-L1043)

**botmux**

- 支持多目标；每项可持有 app-scoped openId、tenant userId、tenant-stable unionId、email、name、avatar。运行时只匹配前三种 ID。[`bot-registry.ts#L1084-L1124`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/bot-registry.ts#L1084-L1124)
- 共享 normalizer 丢弃无 ID 项；enabled 状态必须至少有一个可运行时匹配的 ID，disabled 状态可保留目标以便再开启；chat allow/block list 会 trim、去重，block deny-wins。[`substitute-mode-normalize.ts#L3-L24`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/services/substitute-mode-normalize.ts#L3-L24) [`substitute-mode-normalize.ts#L25-L66`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/services/substitute-mode-normalize.ts#L25-L66)
- Dashboard 保存时把 email/union_id 解析为本 app 可用的 open_id，校验 profile 可见性，区分 cross-app/not-visible/transient/invalid，失败项不持久化但回传 UI。[`substitute-mode-store.ts#L84-L98`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/services/substitute-mode-store.ts#L84-L98) [`substitute-mode-store.ts#L103-L172`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/services/substitute-mode-store.ts#L103-L172)

### 5. 真人发送者门禁与误触发

**botmux**

- 替身只认 `text`/`post`；interactive、merge-forward、file、image 以及缺失 message type 都失败关闭，避免转发内容继承的 mentions 被当作“发送者当场 @”。[`event-dispatcher.ts#L1355-L1390`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/im/lark/event-dispatcher.ts#L1355-L1390) [`event-dispatcher.test.ts#L3554-L3621`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/test/event-dispatcher.test.ts#L3554-L3621)
- bot sender 在 3101 起的独立分支内处理并 return；替身解析位于后续 human 分支，因此 bot 发出的 @target 不进入替身触发。真人仍必须先通过 talk 权限；非授权发送者不会建 session。[`event-dispatcher.ts#L3101-L3376`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/im/lark/event-dispatcher.ts#L3101-L3376) [`event-dispatcher.test.ts#L3717-L3766`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/test/event-dispatcher.test.ts#L3717-L3766)
- match 只比较结构化 mention 的 openId/userId/unionId，不比较显示名或正文字符串。[`event-dispatcher.ts#L1343-L1352`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/im/lark/event-dispatcher.ts#L1343-L1352)

### 6. 披露、CC 与 prompt 注入

**lark-bot-bridge**

- `buildAgentPrompt` 用 JSON 并转义 `<>&`，把 bridge context/instructions 与 user input 分节；静态 OMP system prompt 负责解释这些字段。当前没有替身 policy、披露或 CC。[`prompt.ts#L86-L123`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/agent/prompt.ts#L86-L123) [`bridge-system-prompt.ts#L73-L90`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/src/agent/bridge-system-prompt.ts#L73-L90)

**cc-connect**

- quoted chain 把 app sender 标成 assistant 并展示 peer alias；relay visibility 用 `[from → to]` / `[to]` 标签披露转发过程。没有替身披露或自动 CC。[`feishu.go#L2264-L2288`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L2264-L2288) [`relay.go#L316-L327`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/core/relay.go#L316-L327)

**botmux**

- `prefix`/`none` 都是模型指令而不是确定性文本前缀；`prefix` 要求明确披露，`none` 仅要求适当时代表目标回答。[`session-manager.ts#L788-L837`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/core/session-manager.ts#L788-L837)
- Codex App 路径把 bot-owned policy 放 developer-role context，并把 configured target 与不可信 observed mention 分开；传统终端 CLI 则仍把整个替身 block 放在 user-role prompt 中。[`session-manager.ts#L840-L865`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/core/session-manager.ts#L840-L865) [`session-manager.ts#L1157-L1217`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/core/session-manager.ts#L1157-L1217)
- 替身回复的默认 footer 收件人是本轮真人 caller；`cc` 数组仍为空，配置目标本人不会被自动 @，从而不会把“代答”变成再次唤醒目标或其他 bot。[`bot-routing.ts#L141-L170`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/utils/bot-routing.ts#L141-L170) [`bot-routing.test.ts#L137-L151`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/test/bot-routing.test.ts#L137-L151)

### 7. 配置 UI

- `lark-bot-bridge` 已有 Profile 配置页和 `/api/access`：全局“群里需要 @ bot”以及每个 allowed chat 的“跟随全局/需要 @/无需 @”三态；没有替身或 alias 表单。[`ConfigView.tsx#L73-L118`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/web/src/views/ConfigView.tsx#L73-L118) [`ConfigView.tsx#L178-L219`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/web/src/views/ConfigView.tsx#L178-L219) [`ConfigView.tsx#L694-L741`](https://github.com/chessl/lark-bot-bridge/blob/872aae39ad8e0ae52c171f07e282bc6d525da21b/web/src/views/ConfigView.tsx#L694-L741)
- `cc-connect` 的本项能力仅见 TOML `mention_map`/`resolve_mentions` 配置和 Feishu adapter 解析；`web/` 没有对应专用控件。[`config.example.toml#L1035-L1043`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/config.example.toml#L1035-L1043) [`feishu.go#L313-L343`](https://github.com/chenhg5/cc-connect/blob/3727b7402bd18cfac857629e37d3493323071747/platform/feishu/feishu.go#L313-L343)
- `botmux` Dashboard 暴露 enable、topic 开关、披露、thread/quote、控制卡、chat allow/block list、多目标 ID 类型、异步解析、头像/错误 badge、增删和保存；请求再经 Dashboard→daemon 代理持久化。[`bot-defaults-page.tsx#L3735-L3857`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/dashboard/web/bot-defaults-page.tsx#L3735-L3857) [`bot-defaults-page.tsx#L3931-L4158`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/dashboard/web/bot-defaults-page.tsx#L3931-L4158) [`dashboard-ipc-server.ts#L4055-L4104`](https://github.com/deepcoldy/botmux/blob/085a3df6b38b90028f994ac9dd5cae7c58652a74/src/core/dashboard-ipc-server.ts#L4055-L4104)

## 对 lark-bot-bridge 的推荐 seam

1. **`OutboundMentionResolver` 放在最终 Reply projection 与 Lark request 之间。** 输入仅为最终正文和 profile 中的显式 `alias → openId`；输出为正文、命中的 ID 和是否必须切 text lane。采用 cc-connect/botmux 的最长优先和边界规则，但不扫描成员目录、不从 session 猜 alias。真实 Mention 出现时必须允许 Reply controller 从 card/post 切到 text，否则“看起来像 @”但不会触发对方 bot。
2. **`resolveSubstituteTrigger(msg, profile)` 放在现有 access gate 之后、`requireMentionForChat` 之前。** 仅当 `senderTypeOf(msg) === 'user'`、raw message type 明确为 `text/post`、结构化 mention openId 命中 profile 目标时返回 trigger；bot/unknown sender、显示名匹配、纯正文 `@name`、转发/card/附件一律失败关闭。direct @bot 继续走现有路径。
3. **目标模型先只支持 `openId + name?` 多项。** 当前 SDK/context 已以 openId 为主；不要为了首版引入 email/unionId/userId 解析、联系人可见性 API、头像缓存和 Dashboard preview endpoint。配置装载时校验非空并按 openId 去重即可。
4. **沿用现有 scope 和冻结 Reply target。** 替身不是新 session 类型：普通群继续 chat scope，topic 继续 `chatId:threadId`；每个 run 仍持有不可变 `OmpReplyTarget`。普通群固定 quote-reply 触发消息，不增加 thread/quote 选项、alias registry 或 per-turn 路由账本。
5. **策略与不可信身份分开。** 在可信 `BRIDGE_SYSTEM_PROMPT` 中只定义“当 `bridge_context.substitute` 存在时如何代答”；per-turn context 仅携带 configured target、observed mention 和 trigger message ID，并继续走现有 JSON escaping。不要把事件里的 name 当 instruction，也不要把 bot-owned policy 拼进 user text。
6. **披露确定化，CC 默认关闭。** 最小方案直接在输出边界加固定 `代 <name> 回复：`，不提供 `disclosure=none`；不自动 @ 替身目标，也不自动 @ 其他 bot。若将来需要 CC，应要求显式 openId，而不是从 owner/caller/alias 推断。
7. **配置面复用现有 Profile Config。** 只需在现有配置卡增加 enable、目标列表和 alias map；复用 `/api/config`/profile 持久化。无需新的 Dashboard 服务、daemon 代理、控制卡或运行态 `/substitute` 开关。

## 最小 borrow / reject

### Borrow

- cc-connect：显式 alias map 高优先级、最长名称优先、真实 at 强制 text lane。
- botmux：app-scoped openId、结构化 ID 匹配、真人 + text/post fail-closed gate、configured/observed 身份分离。
- botmux：本轮 Reply target 不可变；默认不隐式 CC/唤醒 bot。
- lark-bot-bridge 现有：access→mention gate 顺序、chat/topic scope、`bridge_context` JSON escaping、单 OMP Reply controller、Profile Config UI。

### Reject

- cc-connect `RelayManager`、chat↔project binding、专用 relay agent session、群可见性回显与自动 permission allow。
- botmux `bots-info.json`/cross-ref/observed/team/oncall/grant/live-roster 身份体系和本地多 bot registry。
- botmux email/unionId/userId 解析、联系人 profile/头像缓存、Dashboard→daemon proxy 与 preview API。
- botmux chat allow/block 双表、运行态 per-chat toggle、topic active-session 开关、thread/quote 选项、owner 控制卡。
- 从 active session、CLI 类型或显示名自动发现 alias；自动 CC 替身目标；任何 bot sender 触发替身。
