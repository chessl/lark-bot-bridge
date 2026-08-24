import { describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  normalizePersonalSubstitution,
  normalizeProfileConfig,
  normalizeTrustedPeerBots,
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
    expect(normalizeProfileConfig({ app, omp, collaboration, mode: 'nonsense' }).mode).toBe(
      'personal',
    );
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

  it('accepts 1-10 targets, retains disabled lists, and rejects the whole invalid set', () => {
    const ten = Array.from({ length: 10 }, (_, index) => `ou_target_${index}`);
    expect(normalizePersonalSubstitution({ enabled: true, targetOpenIds: ten })).toEqual({
      enabled: true,
      targetOpenIds: ten,
    });
    expect(
      normalizePersonalSubstitution({ enabled: false, targetOpenIds: ['ou_first', 'ou_second'] }),
    ).toEqual({ enabled: false, targetOpenIds: ['ou_first', 'ou_second'] });
    expect(() => normalizePersonalSubstitution({ enabled: true, targetOpenIds: [] })).toThrow(
      /at least one target/,
    );
    expect(() =>
      normalizePersonalSubstitution({
        enabled: true,
        targetOpenIds: [...ten, 'ou_eleventh'],
      }),
    ).toThrow(/between 0 and 10/);
    expect(() =>
      normalizePersonalSubstitution({
        enabled: true,
        targetOpenIds: ['ou_duplicate', 'ou_duplicate'],
      }),
    ).toThrow(/duplicated/);
    expect(() =>
      normalizePersonalSubstitution({ enabled: true, targetOpenIds: ['user_target'] }),
    ).toThrow(/open ID/);
  });

  it('validates trusted peer aliases and canonical IDs atomically', () => {
    expect(
      normalizeTrustedPeerBots(
        [
          { alias: 'Hermes_1', openId: 'ou_peer1' },
          { alias: '北斗-2', openId: 'ou_peer2' },
        ],
        'ou_current',
      ),
    ).toEqual([
      { alias: 'Hermes_1', openId: 'ou_peer1' },
      { alias: '北斗-2', openId: 'ou_peer2' },
    ]);

    const invalid = [
      [{ alias: 'all', openId: 'ou_peer' }],
      [{ alias: 'bad alias', openId: 'ou_peer' }],
      [{ alias: '@peer', openId: 'ou_peer' }],
      [{ alias: 'Hermes', openId: 'user_peer' }],
      [
        { alias: 'Hermes', openId: 'ou_peer1' },
        { alias: 'ℌermes', openId: 'ou_peer2' },
      ],
      [
        { alias: 'Hermes', openId: 'ou_peer' },
        { alias: 'Atlas', openId: 'ou_peer' },
      ],
      [{ alias: 'Self', openId: 'ou_current' }],
      Array.from({ length: 11 }, (_, index) => ({
        alias: `Peer${index}`,
        openId: `ou_peer${index}`,
      })),
    ];
    for (const peers of invalid) {
      expect(() => normalizeTrustedPeerBots(peers, 'ou_current')).toThrow();
    }
  });
});
