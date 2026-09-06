import { modelLabel, supportedModels } from '../agent/models';
import type { KnownChat } from '../bot/lark-info';
import type { ProfileMode } from '../config/profile-schema';

export interface ConfigFormOpts {
  /** Deployment mode: 'personal' (default) or 'team'. */
  mode: ProfileMode;
  /** Current model selection (a value from {@link supportedModels}). */
  model: string;
  maxConcurrentRuns: number;
  /** 0 means "disabled". */
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  knownChats: KnownChat[];
  /** URL of the running local web console (supervisor `--web-ui` mode). Shown
   * at the top of the card when present; omitted when no console is running. */
  consoleUrl?: string;
}

function collapsedAccessPanel(title: string, elements: object[]): object {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: title },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements,
  };
}

function atMentionLine(openIds: string[]): string {
  if (openIds.length === 0) return '_（暂无）_';
  return openIds.map((id) => `<at id="${id}"></at>`).join('  ');
}

function chatList(chatIds: string[], knownChats: KnownChat[]): string {
  if (chatIds.length === 0) return '_（暂无）_';
  const nameMap = new Map(knownChats.map((chat) => [chat.id, chat.name]));
  return chatIds
    .map((id) => `- **${nameMap.get(id) ?? '(未知群)'}**（...${id.slice(-6)}）`)
    .join('\n');
}

/** Form card for `/config`. */
export function configFormCard(opts: ConfigFormOpts): object {
  const teamMode = opts.mode === 'team';
  const accessElements: object[] = [
    ...(teamMode
      ? [
          {
            tag: 'markdown',
            content:
              '_⚠️ **团队版已开启**：访问控制暂不生效 —— 任何人 @ bot 都能使用（管理命令仍限 owner/管理员）。切回个人版后以下白名单恢复生效。_',
          },
          { tag: 'hr' },
        ]
      : []),
    {
      tag: 'markdown',
      content:
        '_控制谁能通过私聊和群聊使用 bot。**留空 = 不响应聊天消息**。云文档评论按文档权限生效。_',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**允许私聊的用户**（共 ${opts.allowedUsers.length} 人）\n` +
        `${atMentionLine(opts.allowedUsers)}\n\n` +
        '_加 / 删：_ `/invite user @某人`  `/remove user @某人`',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**允许响应的群**（共 ${opts.allowedChats.length} 个）\n` +
        `${chatList(opts.allowedChats, opts.knownChats)}\n\n` +
        '_一键加全部 bot 所在的群：_ `/invite all group`\n' +
        '_加 / 删（在目标群里发）：_ `/invite group`  `/remove group`',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**管理员**（共 ${opts.admins.length} 人）\n` +
        `${atMentionLine(opts.admins)}\n\n` +
        '_可以跑敏感命令：`/account` `/config` `/exit` `/reconnect` `/doctor` `/cd` `/ws` `/invite` `/remove`。管理员也自动获得私聊权限，并可在未白名单群里管理访问控制。_\n\n' +
        '_加 / 删：_ `/invite admin @某人`  `/remove admin @某人`',
    },
  ];

  return {
    schema: '2.0',
    config: { summary: { content: '偏好设置' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚙️ **偏好设置**\n\n' +
            '调整 bot 的行为偏好。改完点提交后写入当前 profile 配置；消息和访问控制设置立即生效。',
        },
        ...(opts.consoleUrl
          ? [
              {
                tag: 'markdown',
                content:
                  `🖥️ **Web 控制台**（本机 127.0.0.1，可管理所有 profile 的启动/停止与配置）\n` +
                  `[${opts.consoleUrl}](${opts.consoleUrl})`,
              },
            ]
          : []),
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'config_form',
          elements: [
            {
              tag: 'markdown',
              content:
                '**运行模式**\n' +
                '_个人版(默认):Bot 是你一个人的助手,只有你和白名单用户能用;私聊中可按需授权用户身份_\n' +
                '_团队版:Bot 是团队共用的助手,任何人 @ 即可使用(不做白名单校验);只开放应用身份_',
            },
            {
              tag: 'select_static',
              name: 'deploy_mode',
              initial_option: opts.mode,
              options: [
                { text: { tag: 'plain_text', content: '个人版(默认)' }, value: 'personal' },
                { text: { tag: 'plain_text', content: '团队版' }, value: 'team' },
              ],
            },
            { tag: 'hr' },
            {
              tag: 'markdown',
              content:
                '**模型**\n' +
                '_底层 agent 运行使用的模型_\n' +
                '_「跟随默认」= 不指定,由 CLI/账号决定_',
            },
            {
              tag: 'select_static',
              name: 'model',
              initial_option: opts.model,
              options: supportedModels().map((m) => ({
                text: { tag: 'plain_text', content: m.label },
                value: m.value,
              })),
            },
            { tag: 'hr' },
            {
              tag: 'markdown',
              content:
                '\n**并发上限**\n' +
                '_全局同时运行的 agent 进程数(主要影响话题群多话题并行场景)_\n' +
                '_默认 10,范围 1-50。超出的请求会 FIFO 排队_',
            },
            {
              tag: 'input',
              name: 'max_concurrent_runs',
              default_value: String(opts.maxConcurrentRuns),
              placeholder: { tag: 'plain_text', content: '10' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**run 探活(分钟)**\n' +
                '_agent 长时间没输出时自动 kill,防止假死_\n' +
                '_0 = 关闭(默认),范围 1-120。可被 `/timeout` 在单个 scope 覆盖_',
            },
            {
              tag: 'input',
              name: 'run_idle_timeout_minutes',
              default_value: String(opts.runIdleTimeoutMinutes),
              placeholder: { tag: 'plain_text', content: '0' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**群里需要 @ bot**\n' +
                '_是(默认):群和话题群里,不 @ bot 的消息不会触发回复,bot 不接群里聊天_\n' +
                '_否:任何消息都会发给 agent(0.1.21 及更早版本的行为)_\n' +
                '_私聊永远不需要 @;`@全员` 永远不响应_',
            },
            {
              tag: 'select_static',
              name: 'require_mention_in_group',
              initial_option: opts.requireMentionInGroup ? 'yes' : 'no',
              options: [
                { text: { tag: 'plain_text', content: '是(默认)' }, value: 'yes' },
                { text: { tag: 'plain_text', content: '否' }, value: 'no' },
              ],
            },
            collapsedAccessPanel('🔒 **访问控制**（点击展开）', accessElements),
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: 'small',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'submit_btn',
                      text: { tag: 'plain_text', content: '提交' },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'config.submit' } }],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'cancel_btn',
                      text: { tag: 'plain_text', content: '取消' },
                      behaviors: [{ type: 'callback', value: { cmd: 'config.cancel' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

export function configSavedCard(opts: ConfigFormOpts): object {
  const summarize = (list: string[]): string =>
    list.length === 0 ? '_(空)_' : `${list.length} 项`;
  return {
    schema: '2.0',
    config: { summary: { content: '偏好已保存' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **偏好已保存**\n\n' +
            `**运行模式**:\`${opts.mode === 'team' ? '团队版' : '个人版'}\`\n` +
            `**模型**:\`${modelLabel(opts.model)}\`\n` +
            `**并发上限**:\`${opts.maxConcurrentRuns}\`\n` +
            `**run 探活**:\`${opts.runIdleTimeoutMinutes > 0 ? `${opts.runIdleTimeoutMinutes} 分钟` : '关闭'}\`\n` +
            `**群里需要 @ bot**:\`${opts.requireMentionInGroup ? '是' : '否'}\`\n\n` +
            '🔒 **访问控制**' +
            (opts.mode === 'team' ? '（_团队版下不生效,任何人可用_）' : '') +
            '\n' +
            `**允许私聊的用户**:${summarize(opts.allowedUsers)}\n` +
            `**允许响应的群**:${summarize(opts.allowedChats)}\n` +
            `**管理员**:${summarize(opts.admins)}\n\n` +
            '下条消息开始生效。',
        },
      ],
    },
  };
}

/**
 * Shown after `/config` saves "群里不需要 @ bot" but the app is missing the
 * `im:message.group_msg` scope. Guides the user through one-click incremental
 * authorization via the link from `requestScopeGrantLink`.
 */
export function groupMsgScopeGrantCard(url: string, expireMins: number): object {
  return {
    schema: '2.0',
    config: { summary: { content: '需要补授权' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚠️ **「群里不需要 @ bot」还差一个权限**\n\n' +
            '你已开启「不 @ bot 也回复」，但当前应用没有 **获取群组中所有消息**（`im:message.group_msg`）权限。' +
            '没有它，飞书不会把群里非 @ 的消息推给 bot，所以这个设置暂时不生效。\n\n' +
            `**点下面的链接补授权**（约 ${expireMins} 分钟内有效）：\n` +
            `[🔗 点此一键授权](${url})\n\n` +
            '_扫码/点击后会进入确认页，新权限已预填好，确认即可。授权成功后，群里新消息开始自动生效，无需重启。_\n' +
            `_若链接打不开，可复制：_\n\`${url}\`\n\n` +
            '_授权后若群里仍收不到非 @ 消息，发 `/reconnect` 重连一次即可。_',
        },
      ],
    },
  };
}

/** Replaces {@link groupMsgScopeGrantCard} in place once authorization completes. */
export function groupMsgScopeGrantedCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '授权成功' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **授权成功**\n\n' +
            '`im:message.group_msg` 权限已生效，群里非 @ bot 的消息从现在开始会触发回复。\n\n' +
            '_若仍未生效，发 `/reconnect` 重连一次。_',
        },
      ],
    },
  };
}

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消,未做任何修改。' }],
    },
  };
}

export function configFailedCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '保存失败' } },
    body: {
      elements: [{ tag: 'markdown', content: `保存失败：${reason}` }],
    },
  };
}
