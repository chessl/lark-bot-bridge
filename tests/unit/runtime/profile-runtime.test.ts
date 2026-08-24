import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { saveRootConfig } from '../../../src/config/profile-store';
import {
  materializeEnvSecretForService,
  resolveProfileRuntime,
} from '../../../src/runtime/profile-runtime';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const auth = vi.hoisted(() => ({
  validateAppCredentials: vi.fn(async () => ({ ok: true, botName: 'Bridge Bot' })),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bridge-profile-runtime-'));
}

async function withOmp<T>(root: string, fn: (binaryPath: string) => Promise<T>): Promise<T> {
  const binaryPath = await writeVersionExecutable(join(root, 'bin'), 'omp', 'omp 1.0');
  const previous = process.env.LARK_CHANNEL_OMP_BIN;
  process.env.LARK_CHANNEL_OMP_BIN = binaryPath;
  try {
    return await fn(binaryPath);
  } finally {
    if (previous === undefined) delete process.env.LARK_CHANNEL_OMP_BIN;
    else process.env.LARK_CHANNEL_OMP_BIN = previous;
  }
}

describe('OMP profile runtime resolver', () => {
  it('bootstraps a first-run profile from explicit app credentials', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    await withOmp(root, async (binaryPath) => {
      const runtime = await resolveProfileRuntime({
        config: join(root, 'config.json'),
        profile: 'work',
        workspace,
        allowBootstrap: true,
        appId: 'cli_existing',
        appSecret: 'manual-secret',
        tenant: 'feishu',
      });
      const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));

      expect(runtime.profile).toBe('work');
      expect(runtime.cfg.omp.binaryPath).toBe(binaryPath);
      expect(runtime.cfg.workspaces.default).toBe(await realpath(workspace));
      expect(saved.activeProfile).toBe('work');
      expect(saved.profiles.work).not.toHaveProperty('agentKind');
    });
  });

  it('loads an existing OMP profile without a runtime selector', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({
      app: { id: 'cli_existing', secret: 'secret', tenant: 'feishu' },
      omp: { binaryPath: '/usr/local/bin/omp' },
    });
    await saveRootConfig(
      { schemaVersion: 3, activeProfile: 'work', profiles: { work: profile } },
      configPath,
    );

    const runtime = await resolveProfileRuntime({ config: configPath });
    expect(runtime.profile).toBe('work');
    expect(runtime.cfg.omp).toEqual({ binaryPath: '/usr/local/bin/omp' });
  });

  it('creates a managed default workspace when none is supplied', async () => {
    const root = await tmpRoot();
    await withOmp(root, async () => {
      const runtime = await resolveProfileRuntime({
        config: join(root, 'config.json'),
        profile: 'work',
        allowBootstrap: true,
        appId: 'cli_existing',
        appSecret: 'manual-secret',
      });
      expect(runtime.cfg.workspaces.default).toBe(
        await realpath(join(`${root}-workspaces`, 'work', 'default')),
      );
    });
  });

  it('rejects non-interactive bootstrap without complete credentials', async () => {
    const root = await tmpRoot();
    await expect(
      resolveProfileRuntime({ config: join(root, 'config.json'), allowBootstrap: true }),
    ).rejects.toThrow(/非交互模式无法完成扫码创建应用/);
    await expect(
      resolveProfileRuntime({
        config: join(root, 'other.json'),
        allowBootstrap: true,
        appId: 'cli_missing_secret',
      }),
    ).rejects.toThrow(/缺少 App Secret/);
  });

  it('does not materialize a non-environment secret for services', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({
      app: { id: 'cli_existing', secret: 'literal', tenant: 'feishu' },
      omp: { binaryPath: '/usr/local/bin/omp' },
    });
    await saveRootConfig(
      { schemaVersion: 3, activeProfile: 'work', profiles: { work: profile } },
      configPath,
    );
    await expect(materializeEnvSecretForService({ config: configPath })).resolves.toBe(false);
  });
});
