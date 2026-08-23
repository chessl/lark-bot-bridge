import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { evaluateRunPolicy, type RunPolicyInput } from '../../../src/policy/run-policy';

const profileConfig = createDefaultProfileConfig({
  accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
  omp: { binaryPath: '/usr/local/bin/omp' },
});

function input(overrides: Partial<RunPolicyInput> = {}): RunPolicyInput {
  return {
    scope: { source: 'im', actorId: 'ou_user', chatId: 'oc_chat', chatType: 'p2p' },
    attachments: [],
    prompt: 'hello',
    requestedCwd: '/repo',
    cwdRealpath: '/repo',
    access: { ok: true, reason: 'allowed-user' },
    profileConfig,
    now: 1_000,
    ...overrides,
  };
}

describe('OMP run policy', () => {
  it('allows an authorized run with full local access', () => {
    const result = evaluateRunPolicy(input());
    expect(result).toMatchObject({
      ok: true,
      accessMode: 'full',
      prompt: 'hello',
      cwdRealpath: '/repo',
      expiresAt: 301_000,
    });
    expect(result.ok && result.policyFingerprint).toEqual(expect.any(String));
  });

  it('rejects denied access', () => {
    expect(
      evaluateRunPolicy(input({ access: { ok: false, reason: 'denied-user' } })),
    ).toMatchObject({ ok: false, rejectReason: { code: 'access-denied' } });
  });

  it('rejects an unverified folder binding', () => {
    expect(
      evaluateRunPolicy(
        input({
          scope: {
            source: 'comment',
            actorId: 'ou_user',
            resourceBindings: [{ kind: 'folder', id: 'fld_1', verified: false }],
          },
        }),
      ),
    ).toMatchObject({ ok: false, rejectReason: { code: 'folder-allowlist-unverified' } });
  });

  it('rejects a required attachment that was not accepted', () => {
    expect(
      evaluateRunPolicy(
        input({
          attachments: [
            { kind: 'file', requiredness: 'required', decision: 'rejected' },
          ],
        }),
      ),
    ).toMatchObject({ ok: false, rejectReason: { code: 'required-attachment-rejected' } });
  });

  it('changes the fingerprint when the resource scope changes', () => {
    const first = evaluateRunPolicy(input());
    const second = evaluateRunPolicy(
      input({ scope: { source: 'im', actorId: 'ou_user', chatId: 'oc_other', chatType: 'p2p' } }),
    );
    expect(first.ok && second.ok && first.policyFingerprint).not.toBe(
      second.ok && second.policyFingerprint,
    );
  });
});
