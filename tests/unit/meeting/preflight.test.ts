import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { saveRootConfig } from '../../../src/config/profile-store';
import {
  checkMeetingPreflight,
  classifyPreflight,
  MEETING_REQUIRED_EVENTS,
  MEETING_REQUIRED_SCOPES,
  type PreflightClientFactory,
} from '../../../src/meeting/preflight';

/** The exact error lark-cli returns when the app identity lacks the scope. */
const SCOPE_ERROR = {
  ok: false,
  identity: 'bot',
  error: {
    type: 'authorization',
    subtype: 'app_scope_not_applied',
    code: 99991672,
    message: 'access denied for bot identity; recommended scope: vc:meeting.bot.join:write',
    hint: 'ask the app developer to enable scope vc:meeting.bot.join:write',
    missing_scopes: ['vc:meeting.bot.join:write'],
    console_url:
      'https://open.feishu.cn/page/scope-apply?clientID=cli_a9408afb4c781cb3&scopes=vc%3Ameeting.bot.join%3Awrite',
  },
};

describe('classifyPreflight', () => {
  it('extracts missing scopes and the scope-apply URL verbatim', () => {
    const r = classifyPreflight(SCOPE_ERROR);
    expect(r.status).toBe('scope-missing');
    expect(r.missingScopes).toEqual(['vc:meeting.bot.join:write']);
    // Opaque URL: must survive byte-for-byte (no re-encoding of %3A etc).
    expect(r.consoleUrl).toBe(SCOPE_ERROR.error.console_url);
    expect(r.requiredEvents).toEqual(MEETING_REQUIRED_EVENTS);
    // The probe trips on one scope, but the console must show all of them:
    // joining succeeds with bot.join:write alone, then sending fails on
    // message:write — that two-step surprise is what this prevents.
    expect(r.requiredScopes.map((x) => x.scope)).toEqual([
      'vc:meeting.bot.join:write',
      'vc:meeting.message:write',
      'vc:meeting.meetingevent:read',
    ]);
    expect(r.requiredScopes).toEqual(MEETING_REQUIRED_SCOPES);
  });

  it('treats a successful probe as ready', () => {
    const r = classifyPreflight({ ok: true, identity: 'bot', data: { meetings: [] } });
    expect(r.status).toBe('ok');
    expect(r.missingScopes).toEqual([]);
  });

  it('detects the allowlisted beta gate and offers the sign-up link', () => {
    const byCode = classifyPreflight({
      ok: false,
      error: { code: 20017, message: 'ErrNotInGray' },
    });
    expect(byCode.status).toBe('not-in-beta');
    expect(byCode.betaChatUrl).toMatch(/join-chat/);

    const byMessage = classifyPreflight({ ok: false, error: { code: 1, message: 'ErrNotInGray' } });
    expect(byMessage.status).toBe('not-in-beta');
  });

  it('falls back to unknown for unrecognized failures, keeping the message', () => {
    const r = classifyPreflight({ ok: false, error: { code: 12345, message: 'weird' } });
    expect(r.status).toBe('unknown');
    expect(r.message).toBe('weird');
  });

  it('does not crash on garbage', () => {
    expect(classifyPreflight(undefined).status).toBe('unknown');
    expect(classifyPreflight('nope').status).toBe('unknown');
  });
});

describe('checkMeetingPreflight', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'meeting-preflight-'));
    await saveRootConfig(
      {
        schemaVersion: 2,
        activeProfile: 'work',
        profiles: {
          work: createDefaultProfileConfig({
            accounts: { app: { id: 'cli_test', secret: 'app-secret', tenant: 'feishu' } },
          }),
        },
      },
      join(rootDir, 'config.json'),
    );
  });

  afterEach(async () => rm(rootDir, { recursive: true, force: true }));

  it('runs a native read-only bot probe with the target user id', async () => {
    const request = vi.fn(async () => ({
      code: 99991672,
      msg: 'access denied',
      error: { permission_violations: [{ subject: 'vc:meeting.bot.join:write' }] },
    }));
    const createClient: PreflightClientFactory = vi.fn(() => ({ request }));

    const result = await checkMeetingPreflight(
      { profile: 'work', rootDir, probeUserId: 'ou_owner' },
      createClient,
    );

    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/vc/v1/bots/user_active_meeting',
      params: { user_id: 'ou_owner' },
    });
    expect(result.status).toBe('scope-missing');
    expect(result.consoleUrl).toContain('clientID=cli_test');
  });

  it('reports unknown when the native request fails without an API envelope', async () => {
    const createClient: PreflightClientFactory = () => ({
      request: vi.fn(async () => {
        throw new Error('network unavailable');
      }),
    });
    const result = await checkMeetingPreflight(
      { profile: 'work', rootDir, probeUserId: 'ou_owner' },
      createClient,
    );
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('network unavailable');
  });

  it('classifies a rejected SDK response envelope', async () => {
    const createClient: PreflightClientFactory = () => ({
      request: vi.fn(async () => {
        throw { response: { data: { code: 20017, msg: 'ErrNotInGray' } } };
      }),
    });
    const result = await checkMeetingPreflight(
      { profile: 'work', rootDir, probeUserId: 'ou_owner' },
      createClient,
    );
    expect(result.status).toBe('not-in-beta');
  });
});
