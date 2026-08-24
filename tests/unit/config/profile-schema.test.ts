import { describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
} from '../../../src/config/profile-schema';

const app = { id: 'cli_test', secret: 'secret', tenant: 'feishu' as const };
const omp = { binaryPath: '/usr/local/bin/omp' };
const collaboration = {
  trustedPeerBots: [],
  personalSubstitution: { enabled: false, targetOpenIds: [] },
};

describe('OMP profile schema', () => {
  it('defaults deployment mode to personal and parses team', () => {
    expect(createDefaultProfileConfig({ app, omp }).mode).toBe('personal');
    expect(createDefaultProfileConfig({ mode: 'team', app, omp }).mode).toBe('team');
    expect(
      normalizeProfileConfig({ app, omp, collaboration, mode: 'nonsense' }).mode,
    ).toBe('personal');
  });

  it('requires and normalizes OMP configuration when loading', () => {
    expect(() => normalizeProfileConfig({ app, collaboration })).toThrow(/omp/i);
    expect(
      normalizeProfileConfig({
        app,
        omp: { binaryPath: '/usr/local/bin/omp', profile: ' work ' },
        collaboration,
      }).omp,
    ).toEqual({ binaryPath: '/usr/local/bin/omp', profile: 'work' });
  });

  it('rejects an empty OMP binary path', () => {
    expect(() =>
      normalizeProfileConfig({
        app,
        omp: { binaryPath: ' ' },
        collaboration,
      }),
    ).toThrow(/binaryPath/);
  });

  it('keeps supported OMP preferences', () => {
    const cfg = normalizeProfileConfig({
      app,
      omp,
      collaboration,
      preferences: { model: 'custom-model', maxConcurrentRuns: 4 },
    });
    expect(cfg.preferences).toEqual({ model: 'custom-model', maxConcurrentRuns: 4 });
  });

  it('provides attachment and meeting defaults', () => {
    const cfg = createDefaultProfileConfig({ app, omp });
    expect(cfg.attachments.maxCount).toBeGreaterThan(0);
    expect(cfg.meeting).toMatchObject({ enabled: false, respondIn: 'meeting' });
  });

  it('normalizes workspace and access fields', () => {
    const cfg = normalizeProfileConfig({
      app,
      omp,
      collaboration,
      workspaces: { default: ' /repo ' },
      access: {
        allowedUsers: ['ou_user', 1],
        chatRequireMention: { oc_group: false, invalid: 'no' },
      },
    });
    expect(cfg.workspaces).toEqual({ default: '/repo' });
    expect(cfg.access.allowedUsers).toEqual(['ou_user']);
    expect(cfg.access.chatRequireMention).toEqual({ oc_group: false });
  });

  it('requires persisted collaboration and defaults new profiles off', () => {
    expect(() => normalizeProfileConfig({ app, omp })).toThrow(/collaboration/);
    expect(createDefaultProfileConfig({ app, omp }).collaboration).toEqual(collaboration);
  });
});
