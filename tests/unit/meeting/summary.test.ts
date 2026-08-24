import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultProfileConfig,
  MEETING_DEFAULTS,
  type MeetingConfig,
} from '../../../src/config/profile-schema';
import type { VcRequestClient } from '../../../src/meeting/api';
import {
  answerInMeeting,
  attachMeetingAgent,
  resolveSummaryTarget,
  summarizeEndedMeeting,
} from '../../../src/meeting/orchestrator';
import { MeetingSession } from '../../../src/meeting/session';

const mocks = vi.hoisted(() => ({ start: vi.fn() }));

/** A real ProfileConfig — capability resolution reads more than `agentKind`. */
function profileConfig(meeting: MeetingConfig) {
  const pc = createDefaultProfileConfig({
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
  });
  pc.meeting = meeting;
  return pc;
}

const noopClient: VcRequestClient = {
  request: vi.fn(async () => ({ code: 0, data: {} }) as never),
};

/** A run that emits one final assistant response then completes. */
function fakeRun(text: string) {
  return {
    ok: true as const,
    run: {
      metadata: {
        runId: 'run-1',
        scopeId: 'meeting:70001',
        cwdRealpath: '/repo',
        policyFingerprint: 'policy',
      },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'final_text', content: text };
          yield { type: 'done' };
        },
      },
      stop: vi.fn(),
      wasInterrupted: () => false,
    },
  };
}

function makeSession(config: MeetingConfig, originChatId?: string) {
  const s = new MeetingSession({
    client: noopClient,
    meetingId: '70001',
    meetingNo: '123456789',
    topic: '周会',
    config,
    ...(originChatId ? { originChatId } : {}),
  });
  s.ingest({
    event_id: 'e1',
    activity_event_type: 'transcript_received',
    transcript_received_items: [
      { sentence_id: 1, text: '讨论了发布计划', speaker: { name: '甲' } },
    ],
  });
  return s;
}

function deps(config: MeetingConfig, originChatId?: string, botOwnerId?: string) {
  const sent: { to: string; input: unknown }[] = [];
  const session = makeSession(config, originChatId);
  return {
    sent,
    session,
    args: {
      session,
      channel: {
        send: vi.fn(async (to: string, input: unknown) => {
          sent.push({ to, input });
          return {} as never;
        }),
      },
      controls: {
        profile: 'claude',
        profileConfig: profileConfig(config),
        ...(botOwnerId ? { botOwnerId } : {}),
      },
      scopedRuns: { start: mocks.start, interrupt: vi.fn() },
    } as never,
  };
}

function cfg(over: Partial<MeetingConfig> = {}): MeetingConfig {
  return { ...MEETING_DEFAULTS, enabled: true, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockResolvedValue(fakeRun('讨论了发布计划；结论：周五上线。'));
});

describe('summarizeEndedMeeting', () => {
  it('does nothing when summaryOnEnd is off', async () => {
    const d = deps(cfg({ summaryOnEnd: false }), 'oc_team');
    await summarizeEndedMeeting(d.args);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(d.sent).toHaveLength(0);
  });

  it('summarizes to the chat the meeting was joined from', async () => {
    const d = deps(cfg({ summaryOnEnd: true }), 'oc_team');
    await summarizeEndedMeeting(d.args);

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(d.sent).toHaveLength(1);
    const sent = d.sent[0];
    expect(sent?.to).toBe('oc_team');
    if (!sent) throw new Error('expected one sent message');
    const input = sent.input;
    if (!input || typeof input !== 'object' || !('markdown' in input)) {
      throw new Error('expected a markdown message');
    }
    expect(String(input.markdown)).toContain('会议纪要 · 周会');
    expect(String(input.markdown)).toContain('周五上线');
  });

  it('falls back to the bot owner DM when there is no origin chat (console join)', async () => {
    const d = deps(cfg({ summaryOnEnd: true }), undefined, 'ou_owner');
    await summarizeEndedMeeting(d.args);
    expect(d.sent[0]?.to).toBe('ou_owner');
  });

  it('honours summaryTarget=owner even when an origin chat exists', async () => {
    const d = deps(cfg({ summaryOnEnd: true, summaryTarget: 'owner' }), 'oc_team', 'ou_owner');
    await summarizeEndedMeeting(d.args);
    expect(d.sent[0]?.to).toBe('ou_owner');
  });

  it('falls back from owner to the origin chat when the owner is unknown', async () => {
    const d = deps(cfg({ summaryOnEnd: true, summaryTarget: 'owner' }), 'oc_team');
    await summarizeEndedMeeting(d.args);
    expect(d.sent[0]?.to).toBe('oc_team');
  });

  it('skips when there is nowhere to send it', async () => {
    const d = deps(cfg({ summaryOnEnd: true }));
    await summarizeEndedMeeting(d.args);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(d.sent).toHaveLength(0);
  });

  it('skips an empty meeting instead of summarizing nothing', async () => {
    const config = cfg({ summaryOnEnd: true });
    const session = new MeetingSession({
      client: noopClient,
      meetingId: '70001',
      meetingNo: '123456789',
      config,
      originChatId: 'oc_team',
    });
    const sent: unknown[] = [];
    await summarizeEndedMeeting({
      session,
      channel: {
        send: vi.fn(async () => {
          sent.push(1);
          return {} as never;
        }),
      },
      controls: { profile: 'claude', profileConfig: profileConfig(config) },
      scopedRuns: { start: mocks.start, interrupt: vi.fn() },
    } as never);

    expect(mocks.start).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('still works after the meeting ended (transcript survives markEnded)', async () => {
    const d = deps(cfg({ summaryOnEnd: true }), 'oc_team');
    d.session.markEnded(); // what the manager does before invoking onEnded
    await summarizeEndedMeeting(d.args);
    expect(d.sent).toHaveLength(1);
  });
});

describe('answerInMeeting', () => {
  it('uses meeting access and returns collected answer only to the caller', async () => {
    const d = deps(cfg(), 'oc_team', 'ou_owner');

    const answer = await answerInMeeting(d.args, '发布了吗？', { deliver: 'caller' });

    expect(answer).toContain('周五上线');
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'meeting:70001',
        scope: expect.objectContaining({ source: 'meeting', actorId: 'ou_owner' }),
        access: { ok: true, reason: 'allowed-chat' },
        attachments: [],
      }),
    );
    expect(d.sent).toHaveLength(0);
  });

  it('keeps meeting-specific busy guidance and the trigger the asker used', async () => {
    mocks.start.mockResolvedValue({
      ok: false,
      rejectReason: {
        code: 'run-already-active',
        userVisible: 'generic busy',
      },
    });
    const d = deps(cfg(), 'oc_team');

    const answer = await answerInMeeting(d.args, '再试一次', {
      deliver: 'caller',
      usedPrefix: '@助手',
    });

    expect(answer).toBe('上一个任务还在执行。发「@助手 stop」可以中断它，然后再问我。');
  });

  it('returns scoped rejection errors for meeting callers', async () => {
    mocks.start.mockResolvedValue({
      ok: false,
      rejectReason: {
        code: 'pool-full',
        userVisible: '当前无法发起运行，请稍后重试。',
      },
    });
    const d = deps(cfg(), 'oc_team');

    await expect(answerInMeeting(d.args, '再试一次', { deliver: 'caller' })).resolves.toBe(
      '当前无法发起运行，请稍后重试。',
    );
  });
  it('presents in-meeting interruption immediately through the scoped seam', () => {
    let onChat: ((event: unknown) => void) | undefined;
    const sendMessage = vi.fn(async () => {});
    const interrupt = vi.fn(() => true);
    const config = cfg({ trigger: '@bot' });
    attachMeetingAgent({
      session: {
        meetingId: '70001',
        on: vi.fn((_kind, handler) => {
          onChat = handler;
          return () => {};
        }),
        sendMessage,
      },
      channel: { botIdentity: { name: 'bot' } },
      controls: { profile: 'claude', profileConfig: profileConfig(config) },
      scopedRuns: { interrupt },
    } as never);

    onChat?.({
      kind: 'chat',
      content: '@bot stop',
      messageType: 1,
      from: { name: '甲' },
    });

    expect(interrupt).toHaveBeenCalledWith('meeting:70001');
    expect(sendMessage).toHaveBeenCalledWith('已中断当前任务。');
  });
});

describe('resolveSummaryTarget', () => {
  it('prefers the configured target and reports no fallback', () => {
    expect(resolveSummaryTarget('origin', 'oc_a', 'ou_b')).toEqual({
      to: 'oc_a',
      kind: 'origin',
      fellBack: false,
    });
    expect(resolveSummaryTarget('owner', 'oc_a', 'ou_b')).toEqual({
      to: 'ou_b',
      kind: 'owner',
      fellBack: false,
    });
  });

  it('falls back both directions and flags it', () => {
    expect(resolveSummaryTarget('origin', undefined, 'ou_b')).toEqual({
      to: 'ou_b',
      kind: 'owner',
      fellBack: true,
    });
    expect(resolveSummaryTarget('owner', 'oc_a', undefined)).toEqual({
      to: 'oc_a',
      kind: 'origin',
      fellBack: true,
    });
  });

  it('returns undefined when neither lane exists', () => {
    expect(resolveSummaryTarget('origin', undefined, undefined)).toBeUndefined();
    expect(resolveSummaryTarget('owner', undefined, undefined)).toBeUndefined();
  });
});
