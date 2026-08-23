import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { Supervisor } from '../../../src/runtime/supervisor';

const roots: string[] = [];
const started: string[] = [];
const disconnected: string[] = [];
let root: string;
let sup: Supervisor;

function app(id: string) {
  return { id, secret: '${APP_SECRET}', tenant: 'feishu' as const };
}

// Stub startChannel — no network, records lifecycle, returns a minimal bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubStartChannel: any = async (deps: any) => {
  started.push(deps.appPaths.profile);
  return {
    channel: { botIdentity: { name: `bot-${deps.appPaths.profile}` } },
    disconnect: async () => {
      disconnected.push(deps.appPaths.profile);
    },
  };
};

beforeEach(async () => {
  started.length = 0;
  disconnected.length = 0;
  root = await mkdtemp(join(tmpdir(), 'bridge-sup-'));
  roots.push(root);
  const configPath = join(root, 'config.json');

  // personal (cli_a), work (cli_b), dup (cli_b — same app as work).
  await mkdir(join(root, 'profiles', 'personal'), { recursive: true });
  await saveRootConfig(
    createRootConfig(
      'personal',
      createDefaultProfileConfig({ accounts: { app: app('cli_a') } }),
    ),
    configPath,
  );
  const rc = (await loadRootConfig(configPath))!;
  for (const [name, id] of [
    ['work', 'cli_b'],
    ['dup', 'cli_b'],
  ] as const) {
    await mkdir(join(root, 'profiles', name), { recursive: true });
    rc.profiles[name] = createDefaultProfileConfig({
      accounts: { app: app(id) },
    });
  }
  await saveRootConfig(rc, configPath);

  sup = new Supervisor({
    configPath,
    rootDir: root,
    runAgentPreflight: false,
    startChannelFn: stubStartChannel,
  });
});

afterEach(async () => {
  await sup.shutdown();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('Supervisor', () => {
  it('starts a profile in-process and lists it online', async () => {
    await sup.startProfile('personal');
    expect(sup.isOnline('personal')).toBe(true);
    expect(started).toContain('personal');
    const list = sup.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      profile: 'personal',
      online: true,
      pid: process.pid,
      botName: 'bot-personal',
    });
  });

  it('hosts multiple profiles at once', async () => {
    await sup.startProfile('personal');
    await sup.startProfile('work');
    expect(
      sup
        .list()
        .map((s) => s.profile)
        .sort(),
    ).toEqual(['personal', 'work']);
  });

  it('stops one profile without affecting others or the process', async () => {
    await sup.startProfile('personal');
    await sup.startProfile('work');
    await sup.stopProfile('personal');
    expect(sup.isOnline('personal')).toBe(false);
    expect(disconnected).toContain('personal');
    expect(sup.isOnline('work')).toBe(true); // supervisor + other profile still up
  });

  it('refuses to bring up two profiles sharing one app id', async () => {
    await sup.startProfile('work'); // cli_b
    await expect(sup.startProfile('dup')).rejects.toThrow(/已被 profile/);
    expect(sup.isOnline('dup')).toBe(false);
  });

  it('startProfile is idempotent', async () => {
    await sup.startProfile('personal');
    await sup.startProfile('personal');
    expect(started.filter((p) => p === 'personal')).toHaveLength(1);
  });
});
