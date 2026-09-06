# Lark/飞书消息入口 × 可执行 Agent 项目：进程拓扑研究

> 证据截止：2026-08-20。仅用项目自身仓库源码/官方文档；逐项目核验，不沿用未经源码确认的旧结论。本报告区分**逻辑层**（module/库）与 **OS 进程**（`ps` 可见的进程），不把 module 调用误写成 process。

## 0. 结论先行

**问题**：类似“Lark/飞书消息入口 × 可执行/编码 Agent”的项目，是否基本都是 `bridge process → agent process → lark-cli process` 三段 OS 进程链？

**答案：否。** 在去重后的 12 个公开样本中：

- **严格必经三段链**（主/必经路径：bridge OS 进程 → agent OS 进程 → lark-cli OS 进程）：**0/12**。
- **可选/推荐的第三跳相似项**：**1/12**（A8 lark-acp-bridge）。其 README 明确 “strongly recommend pairing with the Lark CLI”，但 **How it works/core topology 仍是 bridge → ACP agent 子进程**，普通回复由 bridge 内 Lark HTTP client/card presenter 发出；lark-cli 是 agent 侧可选外接，非主/必经路径。
- **bridge/daemon 与 agent 同进程**：**6/12**（OpenClaw Feishu、larksuite/openclaw-lark、open-feishu、CowAgent、AstrBot、LangBot）。
- **bridge/daemon 与本地 agent 分进程**：**5/12**（acp-link、cc-connect、botmux、Claude-to-IM-skill、lark-acp-bridge）。botmux 的 bridge 层自身还拆成 daemon/worker，不能简化成恰好两个 OS 进程。
- **外部宿主/服务**：**1/12**（Dify Lark Trigger，工作流由 Dify 平台组件执行）。

两项最能回答问题的事实：

| 事实 | 数量 | 说明 |
|---|---:|---|
| 普通对话主回复经 lark-cli 发出 | **0/12** | 11 个对话型项目都由 bridge/host 内的 Lark SDK/client 发回复；Dify Trigger 没有内建对话回复，工作流显式调用 Feishu tool 直连 OpenAPI |
| Agent 有专门的 Lark tool 回路 | **6/12** | OpenClaw Feishu、openclaw-lark、open-feishu、acp-link、lark-acp-bridge、Dify；其中只有 A8 把 lark-cli 明确推荐为通用外接 |

**“逻辑三层”常见，“OS 三进程”不常见**，原因见 §5。

## 1. 方法与样本边界

复用 `docs/lark-bot-agent-community-landscape.md` 的 12 个公开样本（A1-A11、B1）及其纳入标准。核验动作：对每个项目读依赖清单（package.json / Cargo.toml / go.mod / requirements.txt）与关键源码，搜索 spawn/exec/PTY/stdio/ACP/Agent SDK/Lark SDK/lark-cli 证据点；跳过 formatter、lint、tests。每条分类附项目自身稳定链接。不声称绝对穷尽；证据不足单列，不硬判。

**ACP family 去重**：`JiaqiZhang-Dev/lark-acp`（原始）→ `4t145/lark-acp`（启发/衍生）→ `wthislifehuh/lark-acp-bridge`（对 4t145/lark-acp 的重度修改 fork），另有同族 golang/node 变体（含 ri-char 相关实现，4t145/lark-acp 的 README 即注明其启发这些变体）。三者同属一个 ACP bridge family、拓扑同构（bridge 进程 + ACP agent 子进程），**按 upstream/fork 去重计为 1 个样本（A8）**，避免虚增计数。

本报告只做静态一手资料审计，未启动任何项目。

## 2. 逐项目证据矩阵

图例：ingress=飞书入口所在进程；agent=agent 执行形态（同进程/子进程 stdio/子进程 PTY/SDK 同进程/外部宿主）；出站主回复=回复由谁发出（bridge 内 SDK = 主回复不经 lark-cli）；agent→Lark tools=agent 是否/如何反向调用 Lark 能力；拓扑=实际 OS 进程形态；三段链=主路径是否为 bridge→agent→lark-cli。

### A1. OpenClaw 上游 `@openclaw/feishu`（openclaw/openclaw）

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | Gateway 进程内（channel 插件，`@larksuiteoapi/node-sdk` WS/webhook） | [feishu-ingress.ts](https://github.com/openclaw/openclaw/blob/main/extensions/feishu/src/feishu-ingress.ts) 首行 `import * as Lark from "@larksuiteoapi/node-sdk"`；[package.json](https://github.com/openclaw/openclaw/blob/main/extensions/feishu/package.json) 依赖 `@larksuiteoapi/node-sdk: 1.71.1` |
| agent | 同进程（Gateway 自带 agent runtime）；可选从聊天 `/acp` 拉起外部 ACP 进程 | [docs/channels/feishu.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md) “ACP sessions / Spawn ACP from chat” 一节 |
| 出站主回复 | bridge 内 SDK（插件出站模块） | 同上 package.json/ingress 源码 |
| agent→Lark tools | 有：宿主注册 doc/wiki/drive/Bitable 等 Lark 能力 tools（SDK/MCP，进程内）；可选官方 lark-cli skill（如 VC 工具，由 agent 自主调用） | [feishu.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md) 中 “official `lark-cli` VC agent skill” 段落 |
| 拓扑 | 单 Gateway 进程 +（可选）外部 ACP 子进程 | 同上 |
| 三段链 | **否** | 主回复由插件内 SDK 发出，不经 lark-cli |

### A2. `larksuite/openclaw-lark`

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | OpenClaw Gateway 进程内（channel 插件） | [index.ts](https://github.com/larksuite/openclaw-lark/blob/main/index.ts) `api.registerChannel({ plugin: feishuPlugin })`；[package.json](https://github.com/larksuite/openclaw-lark/blob/main/package.json) 依赖 `@larksuiteoapi/node-sdk` |
| agent | 同进程（继承宿主 Gateway runtime） | 同上 |
| 出站主回复 | bridge 内 SDK（插件 `LarkClient`/messaging outbound） | [index.ts](https://github.com/larksuite/openclaw-lark/blob/main/index.ts) re-export `sendMessageFeishu`/`updateCardFeishu` 等 |
| agent→Lark tools | 有：插件注册 OAPI tools（calendar/task）、MCP doc tools、OAuth 工具，全部进程内 | 同上 |
| 拓扑 | 单 Gateway 进程（插件无独立进程） | 同上 |
| 三段链 | **否** | |

### A3. `xufanglin/acp-link`

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | acp-link 单 Rust 进程（自实现 FeishuChannel，WS 长连接 + REST） | [main.rs](https://github.com/xufanglin/acp-link/blob/main/src/main.rs) 注释“IM 消息监听循环（WS 长连接）”；[im.rs](https://github.com/xufanglin/acp-link/blob/main/src/im.rs) `IMChannel` trait（`reply_message`/`update_message`/`send_card` 均在进程内实现） |
| agent | 子进程 stdio（`tokio::process::Command` spawn kiro-cli，ACP JSON-RPC over stdin/stdout，进程池按 topic 哈希） | [link/acp.rs](https://github.com/xufanglin/acp-link/blob/main/src/link/acp.rs#L145-L153) `tokio::process::Command::new(&config.cmd)...stdin(piped).stdout(piped).spawn()`；[Cargo.toml](https://github.com/xufanglin/acp-link/blob/main/Cargo.toml) 依赖 `agent-client-protocol` |
| 出站主回复 | bridge 内（FeishuChannel in-process REST/卡片） | [im.rs](https://github.com/xufanglin/acp-link/blob/main/src/im.rs) |
| agent→Lark tools | 有：bridge 内嵌 Streamable HTTP MCP server，agent 经 MCP 反向调用 IM 能力（`mcp_tool_list`/`mcp_tool_call`） | [im.rs](https://github.com/xufanglin/acp-link/blob/main/src/im.rs) trait 方法；[main.rs](https://github.com/xufanglin/acp-link/blob/main/src/main.rs) 注释“内嵌 MCP HTTP Server” |
| 拓扑 | 1 个 acp-link 进程 + N 个 agent CLI 子进程（stdio） | 同上 |
| 三段链 | **否**（两段；无 lark-cli） | |

### A4. `ZhiyuanChen/open-feishu`（OpenFeishu Agent）

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | 单 Python 进程（自研 `WsClient`/HTTP dispatcher，非官方 SDK） | [feishu/agent/app.py](https://github.com/ZhiyuanChen/open-feishu/blob/8497d5e5ce01307f662ef05ed82c7b0804541ac4/feishu/agent/app.py) `Agent.run(backend="ws")` → `asyncio.run(self.run_ws())` |
| agent | 同进程（`AgentEngine` + anthropic/openai backend，asyncio） | 同上 `self.engine = self._engine(...)`；[requirements.txt](https://github.com/ZhiyuanChen/open-feishu/blob/master/requirements.txt)（anthropic/openai/websockets，无 lark SDK） |
| 出站主回复 | 同进程（自研 `FeishuClient` 出站） | 同上 app.py |
| agent→Lark tools | 同进程 `ToolRegistry`（JSON Schema tools，可声明 `requires_approval`/OAuth scope）；MCP 可选；无 lark-cli | 同上 |
| 拓扑 | 单进程 | 同上 |
| 三段链 | **否** | |

### A5. `chenhg5/cc-connect`

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | cc-connect 单 Go daemon 进程（`larksuite/oapi-sdk-go` WS + 卡片回调） | [go.mod](https://github.com/chenhg5/cc-connect/blob/main/go.mod) 依赖 `github.com/larksuite/oapi-sdk-go/v3`；[docs/feishu.md](https://github.com/chenhg5/cc-connect/blob/main/docs/feishu.md) “WebSocket 长连接/无需公网 IP” |
| agent | 子进程 PTY（`creack/pty`，按 CLI 分 adapter：claudecode/codex/gemini/cursor/acp/opencode 等目录） | [go.mod](https://github.com/chenhg5/cc-connect/blob/main/go.mod) `github.com/creack/pty`；[agent/ 目录](https://github.com/chenhg5/cc-connect/tree/main/agent) |
| 出站主回复 | bridge 内（Go SDK 出站） | [docs/feishu.md](https://github.com/chenhg5/cc-connect/blob/main/docs/feishu.md) 架构图 `cc-connect ◄──► Claude Code CLI` |
| agent→Lark tools | 无内嵌 Lark MCP；agent 可通过 **`cc-connect send` 自家 CLI/IPC helper** 向聊天回传图片/文件/语音——这是 cc-connect 自己的命令，**不是 lark-cli** | [README.md](https://github.com/chenhg5/cc-connect/blob/main/README.md) 约 L604-614 “cc-connect send --image/--file/--tts” |
| 拓扑 | 1 daemon + N 个 CLI 子进程（PTY） | 同上 |
| 三段链 | **否**（两段；`cc-connect send` 非 lark-cli） | |

### A6. `deepcoldy/botmux`

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | botmux daemon 进程（pm2 托管；Lark 事件/出站用 `@larksuiteoapi/node-sdk`） | [package.json](https://github.com/deepcoldy/botmux/blob/master/package.json) 依赖 `@larksuiteoapi/node-sdk`、`pm2`、`node-pty`；[index-daemon.ts](https://github.com/deepcoldy/botmux/blob/master/src/index-daemon.ts) 启动 daemon |
| agent | 子进程 PTY（worker 每会话 `spawnCli`，`node-pty` `PtyBackend`；backend 还支持 tmux/herdr） | [src/worker.ts](https://github.com/deepcoldy/botmux/blob/master/src/worker.ts) `import * as pty from 'node-pty'`、`PtyBackend`、`spawnCli`；[registry.ts](https://github.com/deepcoldy/botmux/blob/master/src/adapters/cli/registry.ts) 注册 Claude Code/Codex/Gemini/OpenCode/Kiro 等 |
| 出站主回复 | bridge 内（daemon/worker 用 node-sdk 出站） | 同上 package.json |
| agent→Lark tools | 无 lark-cli；agent 可经 `botmux send`/注入命令回传（自家机制） | [worker.ts](https://github.com/deepcoldy/botmux/blob/master/src/worker.ts) `BOTMUX_CHAT_ID`/“post into the current Lark thread” |
| 拓扑 | daemon 进程 + 每会话 worker 进程 + CLI 子进程（PTY）——daemon/worker 分裂是 **bridge 内部**进程分解，不是独立 agent 层，不计为三段链的一环 | 同上 |
| 三段链 | **否**（bridge 内 daemon→worker 是逻辑/内部进程拆分；无 lark-cli） | |

### A7. `op7418/Claude-to-IM-skill`

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | Node daemon 进程（飞书 adapter 使用 `@larksuiteoapi/node-sdk` WS） | [package.json](https://github.com/op7418/Claude-to-IM-skill/blob/main/package.json) |
| agent | SDK 管理的 CLI 子进程：默认 `SDKLLMProvider` 调 `@anthropic-ai/claude-agent-sdk` 的 `query()`；项目构建脚本明确说明该 SDK “spawns a CLI subprocess”，因此必须保持 external。Codex 路径使用 `@openai/codex-sdk` | [src/llm-provider.ts](https://github.com/op7418/Claude-to-IM-skill/blob/main/src/llm-provider.ts)；[scripts/build.js](https://github.com/op7418/Claude-to-IM-skill/blob/536908f5e9bd65a151ca4cb4b08d3fedc1a43b4d/scripts/build.js) |
| 出站主回复 | bridge 内（node-sdk 出站） | 同上 |
| agent→Lark tools | 无（工具来自 Claude/Codex 自身；飞书侧为文本审批，无 Lark tool 回路） | [README](https://github.com/op7418/Claude-to-IM-skill/blob/main/README_CN.md) |
| 拓扑 | 1 daemon 进程 + SDK 管理的 agent CLI 子进程 | 同上 |
| 三段链 | **否**（无 lark-cli） | |

### A8. `wthislifehuh/lark-acp-bridge`（ACP family 代表样本，含 JiaqiZhang-Dev/lark-acp、4t145/lark-acp 及 ri-char 等变体，upstream/fork 去重为一个）

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | lark-acp 单 Node 进程（`@larksuiteoapi/node-sdk` WS） | [package.json](https://github.com/wthislifehuh/lark-acp-bridge/blob/main/package.json) 依赖 `@agentclientprotocol/sdk`、`@larksuiteoapi/node-sdk` |
| agent | 子进程 stdio（ACP JSON-RPC 2.0 over stdio；preset：claude/codex/gemini/kiro/copilot/opencode/q） | [README.md](https://github.com/wthislifehuh/lark-acp-bridge/blob/main/README.md) 架构图 “bridge → ACP agent subprocess (JSON-RPC 2.0 over stdio)” |
| 出站主回复 | **bridge 内**：Lark HTTP client + card presenter（流式卡片、tool 授权、中断、session 恢复都在 bridge 内完成） | 同上 README “How it works” 及架构图 |
| agent→Lark tools | **可选/推荐外接**：README 明确 “strongly recommend pairing with the Lark CLI” 及其 skills，bridge 注入 chat context 后**由 agent 自主选择**调用 lark-cli。此为 agent 驱动的可选路径，非主/必经路径 | [README.md](https://github.com/wthislifehuh/lark-acp-bridge/blob/main/README.md) |
| 拓扑 | 1 daemon + 每 chat 1 个 agent 子进程（stdio） | 同上 |
| 三段链 | **否（主路径两段）**；lark-cli 作为 README 推荐的可选外接，构成“**可选/推荐的第三跳相似项 1 个**”，不计入严格必经三段链 | |

### A9. CowAgent（原 chatgpt-on-wechat）

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | 单 Python 进程（channel adapter，`lark_oapi` WS/webhook） | [channel/feishu/feishu_channel.py](https://github.com/zhayujie/CowAgent/blob/master/channel/feishu/feishu_channel.py)（`_ensure_lark_imported()` 延迟导入 `lark_oapi`；webhook/websocket 双模式） |
| agent | 同进程（Agent Core harness：规划/tool loop/记忆/skills/MCP/sandbox） | 同上 adapter 继承 `ChatChannel` 转发给 bridge；landscape 已核验 |
| 出站主回复 | bridge 内（`lark_oapi` 出站） | 同上 |
| agent→Lark tools | 无 lark-cli；宿主内置工具（终端/浏览器等，工具级子进程由 agent 进程内调用） | 同上 |
| 拓扑 | 单进程（+ 工具子进程） | 同上 |
| 三段链 | **否** | |

### A10. AstrBot

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | 单 Python 进程（adapter，`lark_oapi` socket/webhook） | [lark_adapter.py](https://github.com/AstrBotDevs/AstrBot/blob/b8cd04e4da203eda88ef415f2fb2fb202135c3c5/astrbot/core/platform/sources/lark/lark_adapter.py)（`lark.ws.Client` + `EventDispatcherHandler`，callback 转 async task 进 event_queue） |
| agent | 同进程（event queue → Agent/pipeline，上下文压缩/sandbox） | 同上；landscape 已核验 |
| 出站主回复 | bridge 内（`lark_oapi` 出站，CardKit streaming） | 同上 |
| agent→Lark tools | 无 lark-cli；宿主 MCP/skills/plugins（进程内） | 同上 |
| 拓扑 | 单进程（+ sandbox 子进程） | 同上 |
| 三段链 | **否** | |

### A11. LangBot

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | 单 Python 进程（adapter，`lark_oapi` WS/webhook，`NonBlockingLarkWSClient` 子类在进程内） | [src/langbot/pkg/platform/sources/lark.py](https://github.com/langbot-app/LangBot/blob/7803d562546ab4d56d57ef61e2ebbb94f1a767d1/src/langbot/pkg/platform/sources/lark.py) |
| agent | 同进程（multi-pipeline/provider，tool calling/MCP/插件） | 同上；landscape 已核验 |
| 出站主回复 | bridge 内（`lark_oapi` 出站，CardKit 流式） | 同上 |
| agent→Lark tools | 无 lark-cli；宿主 tool calling/MCP/插件 | 同上 |
| 拓扑 | 单进程 | 同上 |
| 三段链 | **否** | |

### B1. Dify `Lark Trigger`

| 字段 | 结论 | 证据 |
|---|---|---|
| ingress | Dify 部署内（plugin 运行时进程；公网 webhook，`lark_oapi` dispatcher 验签/解密/映射事件） | [triggers/lark_trigger/provider/lark.py](https://github.com/langgenius/dify-official-plugins/blob/c41f1679f41ccffdc35b363123ac89f583a9d88c/triggers/lark_trigger/provider/lark.py) |
| agent | 外部宿主/服务（Dify workflow/agent graph 引擎执行 tools/MCP；trigger 把事件 dispatch 给 Dify 平台，不在插件进程内跑 agent loop） | 同上（`EventDispatch` 返回事件给 Dify）；landscape B1 定性 |
| 出站主回复 | 无原生对话 channel——回复需工作流显式调用 [Feishu 出站 tool](https://github.com/langgenius/dify-official-plugins/blob/main/tools/feishu/tools/feishu_group_bot.yaml)（HTTP API 调用，工具进程内执行） | 同上 |
| agent→Lark tools | 有（工作流出站 tool + 宿主 MCP/tools）；无 lark-cli | 同上 |
| 拓扑 | Dify 平台多进程部署（plugin runtime / core / worker，均为宿主组件），非“bridge→agent”个人拓扑 | 同上 |
| 三段链 | **否** | |

## 3. 统计

分母 = 12（A1-A11、B1；ACP family 已去重为 1 个样本）。

| 分类 | 数量 | 样本 |
|---|---:|---|
| 严格必经三段链（主路径 bridge→agent→lark-cli 三个 OS 进程） | **0/12** | 无 |
| 可选/推荐的第三跳相似项（非必经） | 1/12 | A8 lark-acp-bridge |
| bridge/daemon 与 agent 同进程 | 6/12 | A1、A2、A4、A9、A10、A11 |
| bridge/daemon 与本地 agent 分进程 | 5/12 | A3、A5、A6、A7、A8 |
| 外部宿主/服务 | 1/12 | B1 Dify Lark Trigger |

| 横向事实 | 数量 | 样本 |
|---|---:|---|
| 普通对话主回复经 lark-cli 发出 | **0/12** | 无 |
| 对话型项目由 bridge/host 内 Lark SDK/client 发主回复 | 11/11 | A1-A11；B1 不是对话 channel |
| Agent 有专门的 Lark tool 回路 | 6/12 | A1、A2、A3、A4、A8、B1 |
| 文档或代码路径中出现 lark-cli | 2/12 | A1 可选 VC skill；A8 推荐外接；均非主回复路径 |

## 4. 反例（可直接证伪“普遍三段链”的样本）

1. **A4 open-feishu / A9 CowAgent / A10 AstrBot / A11 LangBot**：bridge 与 agent **同一进程**，连“两段”都不是——不存在独立 agent 进程，更无 lark-cli 进程。
2. **A3 acp-link / A5 cc-connect / A6 botmux / A7 Claude-to-IM-skill / A8 lark-acp-bridge**：agent 在独立本地进程运行，但 Lark 出站由 bridge 内 SDK/client 完成；不存在必经 lark-cli。
3. **A7 Claude-to-IM-skill**：虽然 bridge 通过 Agent SDK 而不是直接 `spawn` 管理 agent，项目构建脚本已明确 SDK 会启动 CLI 子进程；这仍只是 bridge/agent 两类进程，且无 lark-cli。
4. **A5 cc-connect 的 `cc-connect send`**：agent 回传媒体走的是 cc-connect 自家 CLI/IPC helper（`cc-connect send --image/--file/--tts`），这是**自家 CLI，不是 lark-cli**——若把任意“agent 调用的命令行”都算 lark-cli，会误判。
5. **A1/A2 OpenClaw**：agent 默认在 Gateway 进程内执行（可选 ACP 外部进程）；Lark 能力是宿主注册的 tools（SDK/MCP），lark-cli 仅作为**可选的 agent skill** 出现。
6. **ACP family 去重**：JiaqiZhang-Dev/lark-acp → 4t145/lark-acp → wthislifehuh/lark-acp-bridge（+ ri-char/golang 变体）若按仓库名各计一个，会虚增三段链候选；按 upstream/fork 合并后均为同一两段链拓扑。

## 5. 为什么“逻辑三层”常见而“OS 三进程”不常见

逻辑上几乎所有实现都分三层：**Lark ingress/出站层 → agent 层 → 工具层**。但这三层几乎从不映射为三个 OS 进程：

1. **Lark SDK 是库，不是进程**。官方 Node/Go/Python SDK 和自研 client 都能在 bridge 进程内完成 WS 长连接、出站 REST 与卡片更新。11 个对话型样本全部如此；Dify 的显式出站 tool 也直连 OpenAPI。没有样本把普通回复委托给 lark-cli。
2. **“agent CLI”与“lark-cli”是两个不同的东西**。5/12 的本地 bridge 项目会启动 Claude/Codex/Kiro/Gemini 等 agent 进程；lark-cli 则是 Lark 平台能力的工具，属于 agent 的 tool 面，不是消息传输层。
3. **每次多 fork 一层并不能增加正确性**。bridge 已持有凭证、出站队列、卡片序列、去重与降级状态；让普通回复绕道 agent→lark-cli 会复制这些责任并扩大失败面。lark-cli 真正有价值的场景是用户身份 OAuth、广覆盖 OpenAPI 和现成安全门禁，这些是条件性 tool 路径。
4. **两类主流形态都不需要第三进程**。通用 Agent harness 往往把 ingress、agent loop、Lark tools 放在同一宿主进程；coding-agent bridge 往往把 agent CLI/ACP 放到子进程，但仍由 bridge 内 Lark client 负责回复。acp-link 更进一步，把 Lark tool 作为 bridge 内嵌 MCP 暴露给 agent，形成反向调用而非第三个 CLI。

## 6. 本仓库的实际拓扑

本仓库不是一条单线，而是一个有条件分支的进程图：

```text
Supervisor Node process（所有 profile 的 control plane）
├─ @larksuite/channel（同进程）⇄ Lark WS/OpenAPI
├─ 每次 run 启动 Claude/Codex/OMP agent 子进程（stdio JSON/RPC）
│  └─ Agent 需要通用 Lark 能力时，才通过 shell/tool 启动 lark-cli
└─ Console/preflight/身份策略也会直接启动短命 lark-cli 子进程
```

- Supervisor 在一个 Node 进程内托管所有 profile；每个 profile 创建自己的 channel：[supervisor.ts](../src/runtime/supervisor.ts#L270-L334)、[channel.ts](../src/bot/channel.ts#L172-L258)。
- 普通消息经 `RunExecutor` 启动 agent；Claude、Codex、OMP 都是明确的子进程：[run-executor.ts](../src/runtime/run-executor.ts#L93-L131)、[claude/adapter.ts](../src/agent/claude/adapter.ts#L58-L84)、[codex/adapter.ts](../src/agent/codex/adapter.ts#L91-L115)、[omp/adapter.ts](../src/agent/omp/adapter.ts#L71-L85)。
- 普通流式卡片/文本回复由 bridge 的 `channel.send` / `channel.stream` 直接发出，不经过 lark-cli：[channel.ts](../src/bot/channel.ts#L1093-L1249)。
- 只有 Agent 自主调用文档、日历、卡片、OAuth 等 Lark 能力时，system prompt 才要求它启动 lark-cli：[bridge-system-prompt.ts](../src/agent/bridge-system-prompt.ts#L62-L128)。bridge 还会为 UI 的用户群/OAuth 能力直接启动 lark-cli：[user-im.ts](../src/lark-cli/user-im.ts#L70-L100)。

所以对本仓库更准确的描述是：

```text
主对话：Lark ⇄ bridge process ⇄ agent process
条件性工具：bridge process → agent process → lark-cli process → Lark OpenAPI
```

三段链只描述**部分 Agent tool call**，不是整套系统，更不是社区共同主架构。本仓库对 lark-cli 的依赖明显深于大多数样本：12 个外部样本中只有 A8 推荐类似的通用外接，A1 只在可选 skill 中出现。

若目标是减少热路径进程与协议负担，现有 [Lark 能力原生调用调研](./lark-native-integration-research.md) 的混合方案与社区主流一致：保留 agent 子进程 seam；常用 bot 身份能力改由 bridge-owned MCP + `channel.rawClient` 提供；lark-cli 只保留用户 OAuth、长尾能力和现有安全门禁。

## 7. 证据局限

1. 全部为静态源码/官方文档核验，未启动外部项目实测进程树。
2. “主路径”定义为每次/主要回复必经的进程链；可选工具路径不计。
3. B1 的进程拓扑依赖 Dify 部署形态（plugin runtime 与 core 分进程），属宿主组件，与个人 bridge 拓扑不同类。
4. ACP family（JiaqiZhang-Dev/lark-acp → 4t145/lark-acp → wthislifehuh/lark-acp-bridge 及 ri-char 等变体）已按 upstream/fork 去重；若逐仓库计数会虚增候选。
5. 不声称绝对穷尽 12 个样本之外的私有项目、未索引仓库或刚创建项目。