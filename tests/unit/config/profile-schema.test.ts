import { describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
} from '../../../src/config/profile-schema';

const app = { id: 'cli_test', secret: 'secret', tenant: 'feishu' as const };
const omp = { binaryPath: '/usr/local/bin/omp' };

describe('OMP profile schema', () => {
  it('defaults deployment mode to personal and parses team', () => {
    expect(createDefaultProfileConfig({ app, omp }).mode).toBe('personal');
    expect(createDefaultProfileConfig({ mode: 'team', app, omp }).mode).toBe('team');
    expect(normalizeProfileConfig({ accounts: { app }, omp, mode: 'nonsense' }).mode).toBe(
      'personal',
    );
  });

  it('requires and normalizes OMP configuration when loading', () => {
    expect(() => normalizeProfileConfig({ accounts: { app } })).toThrow(/omp/i);
    expect(
      normalizeProfileConfig({
        accounts: { app },
        omp: { binaryPath: '/usr/local/bin/omp', profile: ' work ' },
      }).omp,
    ).toEqual({ binaryPath: '/usr/local/bin/omp', profile: 'work' });
  });

  it('rejects an empty OMP binary path', () => {
    expect(() => normalizeProfileConfig({ accounts: { app }, omp: { binaryPath: ' ' } })).toThrow(
      /binaryPath/,
    );
  });

  it('keeps supported OMP preferences', () => {
    const cfg = normalizeProfileConfig({
      accounts: { app },
      omp,
      preferences: { model: 'custom-model', maxConcurrentRuns: 4 },
    });
    expect(cfg.preferences).toEqual({ model: 'custom-model', maxConcurrentRuns: 4 });
  });

  it('provides attachment cache and meeting defaults', () => {
    const cfg = createDefaultProfileConfig({ app, omp });
    expect(cfg.attachments).toEqual({
      cacheTtlMs: 24 * 60 * 60 * 1000,
      cacheMaxBytes: 512 * 1024 * 1024,
    });
    expect(cfg.meeting).toMatchObject({ enabled: false, respondIn: 'meeting' });
  });

  it('normalizes workspace and access fields', () => {
    const cfg = normalizeProfileConfig({
      accounts: { app },
      omp,
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
});
