import { describe, expect, it } from 'vitest';
import {
  type ConfigFormOpts,
  configFailedCard,
  configFormCard,
  configSavedCard,
} from '../../../src/card/config-card';

const base: ConfigFormOpts = {
  mode: 'personal',
  model: 'default',
  maxConcurrentRuns: 1,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: false,
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('configFormCard console URL', () => {
  it('shows the web console URL when one is running', () => {
    const url = 'http://127.0.0.1:53219/?token=abc123';
    const card = configFormCard({ ...base, consoleUrl: url });
    expect(JSON.stringify(card)).toContain(url);
    expect(JSON.stringify(card)).toContain('Web 控制台');
  });

  it('omits the console section when no console is running', () => {
    const card = configFormCard(base);
    expect(JSON.stringify(card)).not.toContain('Web 控制台');
  });
});

describe('config trusted peer controls', () => {
  const peers = [
    { alias: 'Hermes', openId: 'ou_peer_secret_123456' },
    { alias: 'Atlas', openId: 'ou_atlas_secret_654321' },
  ];

  it('keeps Add/Delete in the existing form and carries the full draft', () => {
    const json = JSON.stringify(configFormCard({ ...base, trustedPeerBots: peers }));
    expect(json).toContain('config.peer-add');
    expect(json).toContain('config.peer-delete');
    expect(json).toContain('trusted_peer_alias_1');
    expect(json).toContain('"cmd":"config.submit","arg":"2"');
    expect(json).not.toContain('ou_peer_secret_123456');
  });

  it('safe-echoes only aliases, counts, and masked ID suffixes after save or failure', () => {
    const saved = JSON.stringify(configSavedCard({ ...base, trustedPeerBots: peers }));
    const failed = JSON.stringify(configFailedCard('整张卡未写入。', peers));
    expect(saved).toContain('Hermes');
    expect(failed).toContain('ID 已隐藏');
    expect(saved).not.toContain('ou_peer_secret_123456');
    expect(failed).not.toContain('ou_peer_secret_123456');
    expect(saved).not.toContain('<at');
    expect(failed).not.toContain('<at');
  });
});
