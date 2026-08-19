# Lark 能力原生调用调研

> 调研时间：2026-08-20

## 结论

有更好的方向，但当前没有一个能同时满足“同进程、全能力、用户 OAuth、现有安全门禁”的稳定 drop-in replacement。

推荐采用**渐进式混合方案**：

1. **Bridge 内部的应用身份调用**：直接复用现有 `@larksuite/channel` 的 `channel.rawClient`，不再自行取 tenant token，也不再启动 `lark-cli`。
2. **Agent 面向的常用能力**：由 bridge 在同一 Node 进程内提供一个只绑定 `127.0.0.1` 的 Streamable HTTP MCP endpoint；底层仍用 `channel.rawClient`。Claude Code、Codex、OMP 都把它识别为原生结构化 tool，从而消除“每次调用再 spawn 一个 lark-cli”的路径。
3. **暂时保留 `lark-cli`**：只负责用户身份的 device flow、OS keychain、refresh token 生命周期、尚未迁移的长尾能力，以及现有 high-risk-write 保护。
4. **不要现在直接内嵌 `@larksuiteoapi/lark-mcp@0.5.1`**：方向正确，但当前 npm 公共入口有 CLI 顶层副作用，且 pnpm 10 下 `keytar` 构建需要额外批准。可把它作为长期运行的 MCP sidecar 做过渡，或等上游提供稳定、无副作用的 library export 后再内嵌。

这同时区分了两个“native”：

- **对模型 native**：模型看到 JSON Schema tool，而不是自己拼 shell 命令、解析 stdout。
- **对 bridge runtime native**：OpenAPI 请求在 bridge 进程内通过 SDK 发出，而不是每次 fork/exec。

Agent 本身已经是独立进程，因此 Agent 到 bridge 之间仍会有 loopback MCP 传输；应消除的是每次 Lark 操作新增的 CLI 子进程，而不是假装不存在进程边界。

## 当前调用链

### Agent 的通用 Lark 能力

`src/agent/bridge-system-prompt.ts:66-128` 明确要求 Agent 通过 `lark-cli` 发卡片、做 OAuth，并把 CLI 的运行约束写入 system prompt。三个 adapter 都只给 Agent 子进程注入 lark-channel 环境变量：

- Claude：`src/agent/claude/adapter.ts:58-90`
- Codex：`src/agent/codex/adapter.ts:91-115`
- OMP：`src/agent/omp/adapter.ts:71-85`
- 环境构造：`src/agent/lark-channel-env.ts:11-30`

因此正常路径是：

```text
bridge Node process
  -> coding-agent process
     -> shell/tool call
        -> lark-cli Go process
           -> Lark OpenAPI
```

问题不只是一点进程启动时间，还包括：命令行参数拼接、stdout/stderr envelope 解析、超时/kill、CLI 版本耦合，以及 OAuth 进程生命周期与 Agent run 生命周期绑定。

### Console 的“我的群”能力

`src/lark-cli/user-im.ts:77-100` 直接 spawn `lark-cli`。同一文件通过 CLI 完成：

- 用户登录状态：`getUserAuthStatus`，`164-181`
- device flow：`startDeviceLogin` / `completeDeviceLogin`，`192-260`
- 用户群列表/搜索：`listUserChats` / `searchUserChats`，`297-338`
- 以用户身份拉 bot 入群：`addBotToChat`，`340-389`

UI 路由位于 `src/ui/api.ts:522-620`。这一组能力必须使用 user access token；bot 身份无法等价地访问“用户自己的群”。

### 已经存在的原生能力

仓库并非完全依赖 CLI：

- `src/bot/channel.ts:258` 创建 `LarkChannel`。
- `src/bot/channel.ts:420-423` 已把 `channel.rawClient` 注入会议模块。
- 已安装的 `@larksuite/channel@0.5.0` 明确把 `rawClient` 作为底层 `Client` 的 escape hatch；本地包文档 `node_modules/@larksuite/channel/README.zh.md:51-60` 和类型 `dist/index.d.mts:1169-1171` 均如此声明。
- `pnpm why @larksuiteoapi/node-sdk` 显示项目已通过 `@larksuite/channel` 安装 `@larksuiteoapi/node-sdk@1.73.0`。

但 `src/bot/cot.ts:20-83` 又自行实现 tenant token 缓存和 `fetch`。这和 `rawClient` 重复，适合先原生化。

## 可复用的一手能力

### 1. `@larksuite/channel` / 官方 Node SDK

这是当前最稳的同进程基础：

- `channel.rawClient` 已经持有 app credentials、domain、HTTP 配置和 tenant-token cache。
- 官方 Node SDK 生成了完整 OpenAPI client；其 README 的“配置请求选项”说明可用 `withUserAccessToken` 注入用户令牌：<https://github.com/larksuite/oapi-sdk-nodejs/blob/main/README.zh.md#配置请求选项>。
- 本机 `@larksuiteoapi/node-sdk@1.73.0` 类型导出也包含 `Client`、`withUserAccessToken`、`withTenantToken`。

准确的 SDK/client entry points 是：

| 能力 | 同进程入口 |
|---|---|
| 列出当前身份所在群 | `channel.rawClient.im.v1.chat.list(payload, options?)` |
| 搜索当前身份可见群 | `channel.rawClient.im.v1.chat.search(payload, options?)` |
| 拉用户或 bot 入群 | `channel.rawClient.im.v1.chatMembers.create(payload, options?)` |
| SDK 尚未生成的 OpenAPI | `channel.rawClient.request({ method, url, data, params }, options?)` |

前三项由官方 Node SDK 的 [IM generated client](https://github.com/larksuite/node-sdk/blob/f54b49f3566c52b54c598194b7ed3015e3e24224/code-gen/projects/im.ts) 提供；user 身份须通过同一物理 SDK 的 `withUserAccessToken` 传入 UAT，否则这些入口默认使用 TAT，语义是 bot 身份。

边界：SDK 能**使用** user access token，但不会替 bridge 完成当前 CLI 的 device flow、OS keychain 存储、跨进程 refresh 锁和身份策略。

### 2. 官方 `lark-openapi-mcp`

官方仓库：<https://github.com/larksuite/lark-openapi-mcp>。

它证明 MCP 是正确的 Agent-facing seam：

- 支持 stdio、SSE、Streamable HTTP；官方用法见 <https://github.com/larksuite/lark-openapi-mcp/blob/main/docs/reference/cli/cli-zh.md>。
- `LarkMcpToolOptions` 支持注入现成的 `client?: lark.Client`，见 <https://github.com/larksuite/lark-openapi-mcp/blob/main/src/mcp-tool/types/index.ts>。
- `LarkMcpTool` 支持 user token getter/setter，并可把生成的 tool 注册到 MCP server，见 <https://github.com/larksuite/lark-openapi-mcp/blob/main/src/mcp-tool/mcp-tool.ts>。
- handler 通过官方 SDK 调用 OpenAPI，并在 UAT 模式使用 `withUserAccessToken`，见 <https://github.com/larksuite/lark-openapi-mcp/blob/main/src/mcp-tool/utils/handler.ts>。

但当前版本不适合作为稳定的同进程依赖：

1. `src/index.ts` 导出 `./cli`：<https://github.com/larksuite/lark-openapi-mcp/blob/main/src/index.ts>。
2. `src/cli.ts` 在模块顶层执行 `program.parse(process.argv)`：<https://github.com/larksuite/lark-openapi-mcp/blob/main/src/cli.ts>。
3. 实测 `import('@larksuiteoapi/lark-mcp')` 会打印 CLI Usage 并以非零状态结束，而不是安静地返回 library exports。
4. 只能导入 `dist/mcp-tool/index.js` 等未公开的私有子路径；这不是可承诺的接口。
5. 包直接依赖 `keytar@7.9.0`。在本项目同版本 pnpm 10 环境的临时安装探针中，安装报告 `ERR_PNPM_IGNORED_BUILDS`；私有子路径虽可加载，但会因缺少 `keytar.node` 打出 storage warning 并退化为 memory store。
6. `larkOapiHandler` 直接执行 SDK 方法；源码中没有 `lark-cli` 的 `high-risk-write` / confirmation gate。不能把当前 CLI 的安全语义视为自动保留。

所以：

- **可作为独立、长期运行的 Streamable HTTP sidecar**，把“每调用一个进程”降为“每 profile 一个常驻进程”。
- **不应通过私有 `dist/*` 子路径内嵌到 bridge**。
- 真正内嵌前，应推动上游拆分无副作用 library entry、声明稳定 exports，并把 keychain/auth 做成可选 adapter。

### 3. MCP 客户端覆盖

本机当前版本均有可落地入口：

- Claude Code：`claude --help` 包含 `--mcp-config` 与 `--strict-mcp-config`。
- Codex：`codex mcp add --help` 明确支持 `--url <URL>` 的 Streamable HTTP server 和 bearer-token env。
- OMP：`omp://mcp-config.md` 明确支持 `type: "http"` + `url` + `headers`，并在 profile 下隔离用户级 MCP 配置。

因此，一个 bridge-owned loopback MCP endpoint 可以成为三种 Agent 的共同 interface，不需要为每个 Agent 实现一套 Lark 业务调用。

## 候选方案比较

| 方案 | 同进程 OpenAPI | 模型结构化 tool | 用户 OAuth/刷新 | 现有风险门禁 | 能力覆盖 | 结论 |
|---|---:|---:|---:|---:|---:|---|
| 继续每次调用 `lark-cli` | 否 | 否，模型走 shell | 完整 | 完整 | 最广 | 保留作 fallback，不再扩张 |
| 直接复用 `channel.rawClient` | 是 | 否 | 不负责 | 需调用方处理 | SDK 全量，但无 tool schema | Bridge 内部调用首选 |
| bridge 内自建最小 MCP + `rawClient` | 是 | 是 | 初期仅 bot | 可在 bridge 统一实现 | 只覆盖显式 allowlist | **当前推荐** |
| 常驻 `lark-openapi-mcp` sidecar | 否，常驻进程 | 是 | 自带 OAuth，但与现有 token store 分叉 | 不等价 | 广 | 仅作过渡/验证，不是最终同进程方案 |
| 私有子路径内嵌 `lark-openapi-mcp` | 是 | 是 | 可接入 | 不等价 | 广 | **拒绝**：不稳定 export + keytar 风险 |
| 直接 `fetch` OpenAPI | 是 | 否 | 全部自研 | 全部自研 | 理论全量 | **拒绝**：重复 SDK token/error/timeout 工作 |
| 把 `@larksuite/cli` 当 Node 库 import | 否 | 否 | 完整 | 完整 | 广 | **不可行**：npm 包是 Go binary launcher，无 public library export |
| 编译 Go extension/shared library | 理论可行 | 仍需 tool layer | 可复用部分 | 可复用部分 | 广 | **拒绝**：cgo/ABI/发布复杂度远高于收益 |

`@larksuite/cli@1.0.83` 的 npm manifest 只有 `bin: scripts/run.js`，没有 `main` / `exports`；`scripts/run.js` 最终执行下载的原生 Go binary。官方仓库也把可扩展方式定位为 Go wrapper/sidecar，而不是 Node library：<https://github.com/larksuite/cli>。

## 身份与安全边界

### Bot identity

立即可以 native：

- profile 已经拥有 app id/secret。
- `channel.rawClient` 已管理 tenant token。
- team mode 本来就强制 `bot-only`，无需引入用户 token。

MCP endpoint 必须在 server 端绑定 profile；不要让模型通过参数选择任意 profile 或身份。

### User identity

暂时不要重写：

- 当前 CLI device flow 自动追加 `offline_access`、轮询 token endpoint、处理 `authorization_pending` / `slow_down` / expiry；官方实现见 <https://github.com/larksuite/cli/blob/main/internal/auth/device_flow.go>。
- token 存在 OS keychain，并按 app id + user open id 隔离；见 <https://github.com/larksuite/cli/blob/main/internal/auth/token_store.go>。
- refresh 包含锁、generation compare-and-swap、失败时保留/清理策略；见 <https://github.com/larksuite/cli/blob/main/internal/auth/uat_client.go>。

仓库现有 `src/config/keystore.ts:8-20` 明确只是防止备份/git/log 意外泄漏，不防同用户进程主动解密。直接把 refresh token 塞进去会降低当前安全等级，不能为了去掉一个子进程这样做。

真正 native UAT 的升级触发条件应是：已有可靠 OS keychain adapter，且 device flow、refresh locking、token rotation、logout/revoke、scope 增量授权都有行为测试。达到之前继续让 CLI 做 auth broker 更便宜、更安全。

### 写操作

MCP tool 是直接调用，不自动继承 CLI 的 high-risk confirmation。第一阶段只开放明确的 read-only allowlist。新增写 tool 时，bridge 必须实现自己的确认协议：

1. 首次调用返回 `confirmation_required`，包含规范化 action、关键参数和一次性 nonce。
2. Agent 把请求展示给用户。
3. 用户明确同意后，下一轮携带 bridge 签发的确认 token 重试。
4. token 绑定 profile、tool、参数摘要、会话和短过期时间，且只能消费一次。

现有卡片 `bridge_token` 也是 bridge 本地语义，不属于 OpenAPI/MCP；它应成为自定义 bridge tool，而不是指望通用 Lark MCP 自动生成。

## 推荐架构

```text
                         one bridge Node process
┌──────────────────────────────────────────────────────────────┐
│ LarkChannel                                                  │
│   └─ rawClient (official Node SDK, tenant token cache)       │
│                                                              │
│ bridge-owned MCP endpoint (127.0.0.1, per-profile bearer)    │
│   ├─ small read-only Lark tool allowlist                     │
│   ├─ bridge-specific tools (signed card callback, etc.)      │
│   └─ policy: profile binding / identity / confirmation       │
└───────────────┬──────────────────────┬───────────────────────┘
                │ Streamable HTTP      │
        ┌───────▼───────┐      ┌──────▼──────┐      ┌────────▼───────┐
        │ Claude Code   │      │ Codex       │      │ OMP            │
        │ native tools  │      │ native tools│      │ native tools   │
        └───────────────┘      └─────────────┘      └────────────────┘

fallback only: coding agent -> lark-cli -> user auth / long tail / guarded writes
```

MCP 是真实 seam：迁移期间确实有 native 与 CLI 两个 adapter；迁移完成后，CLI adapter 可整体删除。不要再加一层只做 pass-through 的通用 `LarkService`。

## 最小迁移顺序

### 阶段 A：零身份风险

1. 把 `CotClient` 等 bot-only 自建 token/fetch 调用迁到 `channel.rawClient`。
2. 不改 user OAuth、不改技能、不改身份策略。
3. 用现有行为测试与一次真实 bot 请求验证响应/错误保持一致。

### 阶段 B：Agent 原生 read-only pilot

1. 直接依赖官方 `@modelcontextprotocol/sdk`，在现有 bridge HTTP server 中增加 Streamable HTTP MCP route；不要手写 MCP 协议。
2. 每个 live profile 创建一组 tool bindings，直接闭包捕获该 profile 的 `channel.rawClient`。
3. endpoint 只绑定 loopback，并要求每次 bridge run 生成的 bearer token。
4. 先开放 2–3 个实际需要的只读工具，例如 bot 可见群列表、消息列表、读取单个群信息。不要一开始复制 2,500 个 OpenAPI schema。
5. adapter 注入：Claude 生成临时 `--mcp-config`；Codex 使用 isolated config/`mcp_servers`；OMP 写入其 bridge-owned profile 的 `mcp.json` 或等价 overlay。
6. 保留现有 lark-cli skill，但把已迁移能力的说明改为优先 native tool；未迁移能力继续 CLI。

### 阶段 C：受控写操作

1. 只按真实需求增加写 tool。
2. 先补齐 high-risk confirmation parity，再迁移对应 CLI 命令。
3. 卡片发送使用 bridge 自有 tool，直接复用当前 channel 和 callback signer。

### 阶段 D：用户身份

仅当用户身份确实成为性能/可靠性瓶颈时再做：

1. 选择稳定的 OS keychain adapter。
2. 在 bridge 内实现并验证 device flow + refresh/token rotation。
3. 通过 SDK `withUserAccessToken` 调 user APIs。
4. 完整迁移 UI 群列表/搜索/拉 bot，并与 CLI 行为做对照测试。
5. 最后删除 `src/lark-cli/user-im.ts`、identity-policy/preflight 依赖和 CLI-specific prompt。不要留双 token store 或兼容 shim。

## 不建议做的事

- 不要把 `@larksuiteoapi/node-sdk` 再包一层“大而全”的内部 SDK。
- 不要手写 tenant-token cache；项目已经有 `channel.rawClient`。
- 不要直接读取 lark-cli keychain 私有格式；那会耦合非公开实现并制造并发刷新竞态。
- 不要依赖 `@larksuiteoapi/lark-mcp/dist/*` 私有路径。
- 不要为了“看起来全量”一次暴露所有 OpenAPI；tool schema 体积、权限和误写风险都会扩大。
- 不要在 native tool 与 CLI tool 之间静默 fallback 写操作；网络不确定性下可能重复创建。fallback 必须只用于确定未发送请求的失败，或由用户明确重试。

## 最终判断

如果目标是**马上减少 subprocess**：先把 bridge 自己的 bot 调用改用 `channel.rawClient`，再做一个最小、只读的 bridge-owned MCP pilot。

如果目标是**马上获得广覆盖结构化 tools**：可评估一个长期运行的 `lark-openapi-mcp` Streamable HTTP sidecar，但要接受它仍是独立进程、用户 token store 分叉、缺少 CLI high-risk gate；它更适合验证 tool UX，不适合直接替代现有安全模型。

如果目标是**彻底删除 lark-cli**：现在不划算。真正的阻塞点不是 HTTP 调用，而是用户 OAuth/keychain/refresh 和写操作安全语义。先迁 bot-only + read-only，等这两块有稳定原生实现再 clean cutover。
