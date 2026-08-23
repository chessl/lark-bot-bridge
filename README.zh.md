# lark-bot-bridge

把飞书 / Lark 消息接到本地 Oh My Pi（OMP）的轻量 bot。OMP 是唯一的 Run 引擎。用一条命令启动，扫码绑定 PersonalAgent 应用，然后在飞书里让 OMP 读图、处理文件、改代码。

[English README](./README.md)

关于能实现的效果，详情可以阅读[飞书文档](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)

## 主要功能

- 在飞书私聊直接发消息，或在群里 `@bot`，把任务转给本机 OMP。
- **即时消息单一 Reply**：每个已启动的 OMP Run 只更新同一个 CardKit Reply，安全展示进度、最终答案、终止状态和实测运行数据。
- **会话延续**：每个聊天、话题或文档评论有自己的会话，不会互相串。
- **排队与消息合并**：短时间连续发送的消息会合并处理；任务运行中收到的普通消息会排队到下一轮，`/new`、`/cd`、`/ws use`、`/stop` 这类命令可以中断当前任务。
- **多工作空间**：用 `/cd` 切换当前项目，用 `/ws` 保存和复用常用项目目录。
- **图片 / 文件**：直接发给 bot，bridge 下载到本地后交给本机 agent 处理。
- **卡片按钮**：`/help`、`/ws list`、`/status` 返回可点击的交互卡片。

## 前置条件

- Node.js **>= 20.12.0**
- 本机已安装并登录 Oh My Pi：`omp`。不支持 Claude Code、Codex 或通用 adapter 配置。
- 一个飞书 / Lark PersonalAgent 应用。首次启动的扫码向导可以帮你创建并绑定。

## 安装

```bash
npm i -g lark-bot-bridge
# 或
pnpm add -g lark-bot-bridge
```

## 首次启动

```bash
lark-bot-bridge run
```

第一次运行会进入扫码向导：

1. 终端渲染二维码。
2. 用飞书 App 扫码。
3. 选择或创建 PersonalAgent 应用。
4. 成功后配置写入 `~/.lark-bot-bridge/config.json`，其中包含已解析的 OMP 路径。

没有指定项目目录也可以启动。bridge 会创建一个 profile 托管的默认工作目录；启动后在飞书里发送 `/cd <path>` 切到实际项目。

如果已经有 PersonalAgent app，可以在初始化时传 `--app-id` 跳过创建应用流程；命令会提示输入 App Secret。

```bash
lark-bot-bridge run --app-id cli_xxx
# 或直接初始化并启动后台服务
lark-bot-bridge start --app-id cli_xxx
```

Lark 国际版应用可加 `--tenant lark`。

## 后台运行

`run` 适合首次配置和前台调试。确认 bot 能正常收发消息后，先用 `Ctrl-C` 停掉前台进程，再用系统服务常驻后台：

```bash
lark-bot-bridge start
lark-bot-bridge status
lark-bot-bridge stop
```

服务层命令必须先全局安装，不能直接用 `npx`。daemon 的 launchd plist 或 systemd unit 会记录 bridge CLI 的路径；如果这个路径来自 npm 临时缓存，缓存清掉后 daemon 就起不来。`run` 用 `npx` 单次启动没问题。

服务层命令按 profile 注册，每个 profile 有独立服务：

```bash
lark-bot-bridge start [--profile <name>]
lark-bot-bridge stop [--profile <name>]
lark-bot-bridge restart [--profile <name>]
lark-bot-bridge status [--profile <name>]
lark-bot-bridge unregister [--profile <name>]
```

平台映射：
- **macOS**：launchd 用户代理 `ai.lark-bot-bridge.bot.<profile>`
- **Linux**：systemd 用户单元 `lark-bot-bridge.bot.<profile>.service`

daemon 日志在 `~/.lark-bot-bridge/profiles/<profile>/logs/daemon/`。

### 多个 OMP profile

bridge 默认使用当前激活的 profile；可以通过 `profile use <name>` 切换。每个 profile 维护独立的 PersonalAgent 应用凭据、OMP 会话、工作目录和日志。只有需要连接多个应用作为不同 OMP bot 时才创建多个 profile：

```bash
lark-bot-bridge profile create work
lark-bot-bridge profile create personal
lark-bot-bridge start --profile work
```

只重启一个 profile：

```bash
lark-bot-bridge restart --profile work
lark-bot-bridge status --profile work
```

## 命令速查

### 宿主 CLI

```text
lark-bot-bridge run [--profile <name>] [--workspace <path>] [-c <config>]
lark-bot-bridge ps
lark-bot-bridge kill <id|#>
lark-bot-bridge --help
```

`profile use <name>` 会切换后续默认启动使用的 profile。需要连接多套 PersonalAgent 应用或做脚本化部署时，可以使用这些 profile 管理命令：

```bash
lark-bot-bridge profile create work
lark-bot-bridge profile create personal
lark-bot-bridge profile list
lark-bot-bridge profile use <name>
lark-bot-bridge profile remove <name>
lark-bot-bridge profile remove <name> --purge --yes
lark-bot-bridge profile export <name> [--output ./profile.json] [--force]
lark-bot-bridge profile export <name> --include-secrets --yes
```

`profile remove` 默认归档本地状态，也可以删除当前激活的 profile。若还剩其他 profile，会自动切到下一个；若这是最后一个 profile，会清空 root config，之后可以用同名重新创建。只有加 `--purge --yes` 才会永久删除。`profile export` 默认脱敏 app secret；只有加 `--include-secrets --yes` 才会导出敏感配置。


### 飞书内斜杠命令

| 命令 | 作用 |
|---|---|
| `/new`, `/reset` | 清空当前会话 |
| `/cd <path>` | 切换工作目录并重置会话 |
| `/ws list` | 列出命名工作空间 |
| `/ws save <name>` | 把当前工作目录保存为命名工作空间 |
| `/ws use <name>` | 切换到命名工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/resume` | 恢复同工作目录和策略下的当前 OMP 会话 |
| `/status` | 查看 profile、OMP 引擎、工作目录、会话和运行状态 |
| `/config` | 调整 OMP 模型、运行限制、会议行为和访问控制 |
| `/invite user @某人` | 允许用户私聊使用 bot |
| `/invite admin @某人` | 添加访问控制管理员 |
| `/invite group` | 允许当前群使用 bot |
| `/invite all group` | 允许 bot 所在的所有群使用 |
| `/remove user @某人`, `/remove admin @某人`, `/remove group` | 移除访问控制条目 |
| `/stop` | 停止当前 Run |
| `/timeout [N\|off\|default]` | 设置或清除当前会话的 idle watchdog |
| `/ps` | 列出本机 bridge 进程 |
| `/exit <id\|#>` | 停止指定 bridge 进程 |
| `/reconnect` | 强制 WebSocket 重连 |
| `/doctor [描述]` | 执行低敏诊断 |
| `/help` | 帮助卡片 |

私聊不需要 @。群和话题群默认必须 `@bot`；`@all` 会被忽略。支持的云文档评论里 @bot 就会触发回复。

## 即时消息统一 Reply

所有由即时消息启动的 OMP Run 只有一条生产 Reply 路径。bridge 在消费 OMP 事件前，先回复已接收 Message Batch 的最后一条消息，之后只更新同一个 CardKit 气泡。私聊和普通群保留原生消息引用；话题和明确要求线程回复的 Invocation 留在对应话题或线程内。

Run 进行中时，Reply 展开安全的 Reasoning 和工具状态。发生 Run Termination 后，两部分都会收起，卡片保留 Final Reply、终止状态、model/effort/context 信息和可用 RunMetrics。隐藏思考、工具输入输出、命令、路径、查询、原始错误、provider 信息和 fallback 原因都不会展示。Reply 最多保留最近 12 条 Reasoning 和 20 行工具状态。

每张卡片都受 CardKit 30 KB、200 元素限制。超过预算时，bridge 先删除最早的 Reasoning，再删除最早的工具行。如果 Final Reply 仍然过长，会在合法 UTF-8 边界截断并追加 `内容过长，已截断`。一个 Run 不会被拆成第二条 Reply。

Commands 和 Run Rejections 继续使用普通直接回复。会议、文档评论和卡片操作 Invocation 保持原有交付方式，不进入即时消息统一 Reply 路径。

### Delivery Failure 与重启恢复

Run Termination 和 Reply 交付结果相互独立。如果已知气泡无法更新或关闭，bridge 会在结构化日志中记录 **Delivery Failure**，不会补发替代消息。因此 OMP Run 成功不代表终态 Reply 一定已送达飞书。

每个 profile 用本地交付 journal 保存活跃交付标识，以及最多一个内容完全确定但尚未解决的请求。journal 采用原子写入，文件 mode 为 `0600`。bridge 重启后，只会在飞书一小时 UUID 去重窗口内精确重试结果未知的首次提交；已知消息只会在 14 天更新窗口内原位终态化，并把已断开的 Run 标为“已中断”。尚未提交的条目直接丢弃；过期、损坏或语义不确定的状态一律 fail closed，不猜测，也不创建第二个气泡。

### 客户端支持范围

| 客户端 | 统一 Reply 支持 |
|---|---|
| 中国版飞书 PC 7.32 及以上 | 支持目标 |
| 中国版飞书 PC 7.32 以下 | 不支持 |
| 中国版飞书 iOS / Android | 不支持 |
| Lark 国际版客户端 | 不支持 |

会议、文档评论、命令卡片和卡片操作不属于这份统一 Reply 客户端契约。

## 原生 Lark 工具与用户身份

每次 OMP run 都会获得一个只绑定 loopback、使用一次性 bearer token 的 `lark_bridge` Streamable HTTP MCP endpoint。Bot 群聊读取、消息读取、Docx block 读取和 CardKit 发送都直接复用 bridge 进程内的 Lark SDK client；写工具在原飞书会话内确认后才执行。

个人版 profile 的私聊可以通过原生工具发起 Lark device OAuth。token 元数据按 profile 保存，access/refresh token 只进入 OS keychain，并在 profile/app/user 锁内刷新。团队版、群聊、话题、云文档评论和会议 run 都不会获得用户身份。

## 工作目录

每个 profile 都可以有一个默认工作目录：`workspaces.default`。新建 profile 时可以传 `--workspace <path>` 作为初始目录；没传时 bridge 会创建一个 profile 托管的默认工作目录。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `workspaces` 字段。

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-bot-bridge-workspaces/omp/default"
  }
}
```

bridge 会检查所选目录存在、是目录，并且不是 `/`、Home 根、系统目录或临时目录根这类范围过大的位置。OMP RPC 使用 `yolo` approval mode，因此工作目录只是当前目录，不是文件系统 sandbox。

## OMP profile 配置

每个 profile 只有一份 OMP 运行配置。`binaryPath` 在 bootstrap 时解析；可选的 `profile` 用来选择 OMP profile：

```json
{
  "omp": {
    "binaryPath": "/usr/local/bin/omp",
    "profile": "work"
  }
}
```

创建 profile 前可设置 `LARK_CHANNEL_OMP_BIN` 指向非默认 OMP。产品不提供 agent 选择器或其他运行时。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-bot-bridge/config.json` | root config，包含 profiles 和 active profile |
| `~/.lark-bot-bridge/profiles/<profile>/sessions.json` | 会话状态 |
| `~/.lark-bot-bridge/profiles/<profile>/sessions.json.catalog.json` | OMP 会话索引 |
| `~/.lark-bot-bridge/profiles/<profile>/workspaces.json` | 当前和命名工作空间绑定 |
| `~/.lark-bot-bridge/profiles/<profile>/secrets.enc` | profile 本地加密 secret |
| `~/.lark-bot-bridge/profiles/<profile>/user-auth.json` | 用户 OAuth 元数据；token 保存在 OS keychain |
| `~/.lark-bot-bridge/profiles/<profile>/media/` | 附件缓存 |
| `~/.lark-bot-bridge/profiles/<profile>/logs/` | 结构化运行日志 |
| `~/.lark-bot-bridge/profiles/<profile>/active-deliveries.json` | 仅 owner 可读写的 Reply 精确交付与重启恢复 journal |
| `~/.lark-bot-bridge/registry/processes.json` | 本机进程注册表 |
| `~/.lark-bot-bridge/registry/locks/` | profile lock 和 app lock |

设置 `LARK_CHANNEL_HOME=/path/to/state` 可以迁移整棵本地状态目录。`LARK_CHANNEL_LOG_DAYS` 可以调整日志保留天数。

## 访问控制

**聊天访问默认是私有的：开箱即用时，只有"你"能在私聊和群聊里用这个 bot。** 这里的"你" = 创建 / 拥有这个飞书应用的人（也就是扫码把 bot 建起来的那位）。bot 会自动从飞书查出谁是应用 owner，所以**一个人用聊天入口完全不用配置**——你私聊它、在任意群里 @它都正常工作，其他人的聊天消息会被静默忽略（bot 不会回"你没权限"，免得暴露自己的存在）。云文档评论按文档权限生效，见下文。

想让别的同事或某些群也能用，就把他们加进下面三类名单：

| 名单 | 控制谁 | 加入 | 移除 |
|------|--------|------|------|
| **允许私聊的用户** | 谁可以私聊 bot | `/invite user @某人` | `/remove user @某人` |
| **响应的群** | bot 在哪些群里对**群内所有人**响应 | `/invite group`（当前群）/ `/invite all group`（bot 所在的全部群） | `/remove group`（当前群） |
| **管理员** | 谁能改设置、并能在任意群用 bot | `/invite admin @某人` | `/remove admin @某人` |

> `/invite`、`/remove` 这些命令只有**你（创建者）和管理员**能发。命令里 @ 的是**对方**（不是 @ bot），bot 会自动把 @ 解析成对应的人，你不用手动去找 ID。

### 两种"畅通无阻"的身份

- **你（创建者）**：不受任何名单限制——私聊、任意群、所有命令都能用，而且**永远锁不死自己**：哪怕名单配乱了，回到 bot 私聊发 `/config` 总能进来。在飞书后台把应用 owner 转给别人后，bot 也会自动跟着切换。
- **管理员**：能私聊、能用 `/config` 等管理命令，而且**不受"响应的群"名单限制**——无论群在不在名单里，bot 都会回他们。适合给一起维护 bot 的同事。

### 几种常见配置

- **只给自己用** → 什么都不用做，默认就是。
- **让某个同事能私聊 bot** → `/invite user @他`
- **让某个工作群里所有人都能用** → 在那个群里发 `/invite group`
- **第一次配，想把 bot 已经在的群一次性全开放** → 发 `/invite all group` 一键拉取 bot 所在的全部群加入名单，之后再用 `/remove group` 删掉不想要的
- **再拉个人一起当管理员** → `/invite admin @他`

### 还需要知道的

- 改完**下一条消息**就生效，不用重启。
- **群里默认要先 @bot 才会回**（私聊不用 @）。这是另一个独立开关（`/config` →"群里需要 @ bot"），和上面的名单是两回事。
- 陌生人发消息一律静默丢弃，不会有任何回复。唯一的例外：有人在一个还没开放的群里 @bot，bot 会回一句友好提示，告诉他可以让管理员发 `/invite group` 开放这个群。
- 云文档评论按文档权限生效：能在支持的文档里评论并 @bot 的人可以触发回复。

### 高级：直接改配置文件

不想在飞书里点的话，`/invite`、`/config` 背后写的是 `~/.lark-bot-bridge/config.json` 中对应 profile 的 `access` 字段。空白名单表示这个名单没人，不表示所有人都能用。下面只是 profile 里的字段片段，不要整段覆盖 `config.json`：

```json
{
  "schemaVersion": 2,
  "profiles": {
    "work": {
      "omp": {
        "binaryPath": "/usr/local/bin/omp"
      },
      "access": {
        "allowedUsers": ["ou_xxxxxxxxxxxxx"],
        "allowedChats": ["oc_xxxxxxxxxxxxx"],
        "admins": ["ou_xxxxxxxxxxxxx"],
        "requireMentionInGroup": true
      }
    }
  }
}
```

`allowedUsers` / `admins` 填用户 `open_id`，`allowedChats` 填群 `chat_id`。手动找 ID 最简单的办法：让对方给 bot 发条消息（群里就 @ 它一下），然后看当前 profile 的日志：

```bash
grep '"event":"enter"' ~/.lark-bot-bridge/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

每行都带 `chatId`（群 / 私聊 ID）和 `senderId`（用户 `open_id`）。手改完后**重启 bridge**，或在允许的 admin 上下文里发 `/reconnect` 让它生效。日常调整还是 `/invite` / `/config` 更省事，直接改文件主要用于部署脚本预填。

## 云文档评论

云文档评论不再需要单独绑定工作目录或维护文档白名单。支持的文档评论里 @bot 后，bridge 会在同一个评论线程里回复。评论运行复用文档级 session key；没有记录过文档 cwd 时回退到用户 home 目录。

## 常见问题

**bot 没反应 / OMP 不回复**：通常是本机 `omp` 没登录，或者当前会话指向了不存在的工作目录。发 `/status` 看当前状态；`/new` 重开会话往往就好。

**Reply 停在旧画面**：检查当前 profile 的结构化日志里是否有 `Delivery Failure` 或恢复事件。提交结果不确定或已经知道气泡存在时，bridge 不会补发第二条消息。重启后，可恢复的原气泡会被更新为“已中断”；未提交状态直接丢弃，过期或损坏的 journal 会 fail closed。

**图片发过去 agent 说看不到**：升级到最新版，0.1.0 之前的版本有文件名去重 bug。

## 测试与 CI

本地检查：

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` 包含 unit、integration 和 process-level adapter 测试。CI 在 macOS 和 Ubuntu 上执行 `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm typecheck` 和 `pnpm build`。


## 许可

[MIT](./LICENSE)

<img src="./assets/feedback-group-qr.png" alt="飞书反馈群二维码" width="360">
