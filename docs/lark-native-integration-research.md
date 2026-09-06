# Lark 能力原生调用调研

> 调研时间：2026-08-20

## 结论与实施状态

推荐架构已于 2026-08-20 一次性落地：

1. Bridge 的 bot 调用统一复用 `channel.rawClient`；会议 preflight 也不再自行取 tenant token 或启动 `lark-cli`。
2. Bridge 在同一 Node 进程内提供只绑定 `127.0.0.1` 的 Streamable HTTP MCP endpoint。每个 run 单独签发 bearer token，并绑定 profile、会话和 policy fingerprint。
3. OMP 启动时获得临时 MCP 配置；token 只通过环境变量传递，不进入 argv、system prompt、session 记录或持久配置。
4. 常用 bot reads、Docx blocks、CardKit 发送、工作区图片上传、用户 OAuth 和拉 bot 入群已迁入原生工具。破坏性或跨会话写操作由 bridge 在原飞书会话内发确认卡，签名确认绑定 run/scope/actor 且一次性消费。
5. 用户 access/refresh token 存在 OS keychain；磁盘只保存 profile-local 元数据。刷新在 profile/app/user 跨进程锁内完成完整的 read-refresh-write。
6. 原 `src/lark-cli/user-im.ts`、身份策略、启动 preflight、profile projection 和 CLI-specific agent 配置均已删除；runtime 不再依赖 `lark-cli`。

仍不内嵌 `@larksuiteoapi/lark-mcp`：公共入口副作用、私有 export 和 `keytar` 构建风险没有变化。工具继续按真实产品需求加入 bridge-owned allowlist，不复制全量 OpenAPI schema。

这同时区分了两个“native”：

- **对模型 native**：模型看到 JSON Schema tool，而不是自己拼 shell 命令、解析 stdout。
- **对 bridge runtime native**：OpenAPI 请求在 bridge 进程内通过 SDK 发出，而不是每次 fork/exec。

Agent 本身已经是独立进程，因此 Agent 到 bridge 之间仍会有 loopback MCP 传输；应消除的是每次 Lark 操作新增的 CLI 子进程，而不是假装不存在进程边界。

## 迁移后的调用链

### Agent 的通用 Lark 能力

`src/lark-native/server.ts` 在 bridge 进程内提供 MCP endpoint，并直接闭包捕获当前 profile 的 `channel.rawClient`。`src/runtime/run-executor.ts` 为每个 run 创建/销毁 endpoint；三个 adapter 只注入临时 MCP 配置：

- Claude：临时 `--mcp-config`
- Codex：临时 server 配置 + bearer 环境变量
- OMP：bridge-owned profile `mcp.json` overlay，run 结束后恢复

```text
bridge Node process
  ├─ LarkChannel.rawClient
  └─ 127.0.0.1 Streamable HTTP MCP
       ↑ bearer token bound to one run
       └─ coding-agent process
```

模型看到 JSON Schema tool；OpenAPI 请求回到同一个 bridge 进程执行。不存在“Agent shell → lark-cli → OpenAPI”的逐调用子进程。

### Console 的“我的群”能力

`src/lark-native/user-im.ts` 原生实现用户登录状态、device flow、token refresh/rotation、群列表/搜索和以用户身份拉 bot 入群。SDK 调用通过 `withUserAccessToken` 使用 UAT；`src/lark-native/keychain.ts` 把 token 存入 macOS Keychain 或 Linux Secret Service。UI 路由复用同一模块，不再有第二套 token store。

### 已经存在的原生能力

仓库并非完全依赖 CLI：

- `src/bot/channel.ts:258` 创建 `LarkChannel`。
- `src/bot/channel.ts:420-423` 已把 `channel.rawClient` 注入会议模块。
- 已安装的 `@larksuite/channel@0.5.0` 明确把 `rawClient` 作为底层 `Client` 的 escape hatch；本地包文档 `node_modules/@larksuite/channel/README.zh.md:51-60` 和类型 `dist/index.d.mts:1169-1171` 均如此声明。
- `pnpm why @larksuiteoapi/node-sdk` 显示项目已通过 `@larksuite/channel` 安装 `@larksuiteoapi/node-sdk@1.73.0`。

即时消息 Run 的 CardKit 交付和会议 preflight 都复用进程内 `rawClient`，仓库不再保留第二套 bot token/fetch client。

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
| 继续每次调用 `lark-cli` | 否 | 否，模型走 shell | 完整 | 完整 | 最广 | **已从 runtime 删除** |
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

原生 UAT 已落地，并维持原安全等级：

- device flow 自动申请 `offline_access`，处理 `authorization_pending`、`slow_down` 和 expiry。
- keychain account 由 app id + user open id 隔离；`user-auth.json` 只保存非敏感元数据。
- refresh 在 profile/app/user 跨进程锁内串行完成 read-refresh-write，避免并发 token rotation 覆盖。
- refresh 失败保留仍可重试的 token；终止错误才清理；logout 同时 revoke 并删除 keychain/metadata。
- user tool 只对 personal profile 的 p2p IM run 开放；team、群聊、topic、评论和会议 run 在 server 端拒绝。

### 写操作

MCP 不继承外部 CLI 的风险门禁，因此 bridge 自己执行确认协议：

1. 写 tool 规范化操作并向当前会话发送确认卡。
2. 卡片 callback 携带 bridge 签名 token，绑定 run、scope、chat、actor、action 和短 TTL。
3. callback dispatcher 校验签名和操作者后，唤醒对应 pending approval。
4. approval id 只能消费一次；拒绝、超时、run 结束或 server 关闭都不会发送写请求。

Agent 生成的 CardKit callback 同样由 bridge 递归签名；回调只会恢复原 run/scope，模型不能伪造跨会话 callback。

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

all Lark operations shown above execute in the bridge process
```

MCP 是真实 seam：迁移期间确实有 native 与 CLI 两个 adapter；迁移完成后，CLI adapter 可整体删除。不要再加一层只做 pass-through 的通用 `LarkService`。

## 最小迁移顺序

### 阶段 A：零身份风险

1. bot-only 调用已统一迁到 `channel.rawClient`。
2. user OAuth、技能和身份策略保持独立边界。
3. 行为测试覆盖 native 请求、响应和错误分类。

### 阶段 B：Agent 原生 read-only pilot

1. 直接依赖官方 `@modelcontextprotocol/sdk`，在现有 bridge HTTP server 中增加 Streamable HTTP MCP route；不要手写 MCP 协议。
2. 每个 live profile 创建一组 tool bindings，直接闭包捕获该 profile 的 `channel.rawClient`。
3. endpoint 只绑定 loopback，并要求每次 bridge run 生成的 bearer token。
4. 先开放 2–3 个实际需要的只读工具，例如 bot 可见群列表、消息列表、读取单个群信息。不要一开始复制 2,500 个 OpenAPI schema。
5. adapter 注入：Claude 生成临时 `--mcp-config`；Codex 使用 isolated config/`mcp_servers`；OMP 写入其 bridge-owned profile 的 `mcp.json` 或等价 overlay。
6. 已迁移能力只通过 native tool；未暴露能力明确报错，不做隐式写 fallback。

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

当前实现已经达到目标状态：常用 Lark 能力对模型和 bridge runtime 都是 native；三个 agent adapter 共用一个 MCP seam；bot token、user token、写确认和 callback 签名都由 bridge 统一管理。

后续只在出现真实产品需求时增加窄工具。继续拒绝全量 schema 复制、通用 pass-through `LarkService`、私有 `lark-mcp/dist/*` import，以及任何 native/CLI 间的隐式写 fallback。
