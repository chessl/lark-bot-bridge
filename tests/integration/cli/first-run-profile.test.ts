import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBootstrapProfileConfig } from '../../../src/cli/profile-bootstrap';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-first-run-profile-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OMP profile bootstrap', () => {
  it('resolves the OMP binary and requested workspace', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const omp = await writeVersionExecutable(root, 'omp', 'omp 1.2.3');

    const profile = await createBootstrapProfileConfig({
      app: { id: 'cli_omp', secret: 'secret', tenant: 'feishu' },
      workspace,
      ompBinaryPath: omp,
    });

    expect(profile.omp).toEqual({ binaryPath: omp });
    expect(profile.workspaces).toEqual({ default: await realpath(workspace) });
  });

  it('creates a managed default workspace when no user workspace is provided', async () => {
    const root = await makeRoot();
    const defaultWorkspace = join(root, 'managed-workspaces', 'omp', 'default');
    const omp = await writeVersionExecutable(root, 'omp', 'omp 1.2.3');

    const profile = await createBootstrapProfileConfig({
      app: { id: 'cli_omp', secret: 'secret', tenant: 'feishu' },
      ompBinaryPath: omp,
      defaultWorkspace,
    });

    expect(profile.workspaces.default).toBe(await realpath(defaultWorkspace));
  });

  it('reports missing OMP binaries as preflight diagnostics', async () => {
    const root = await makeRoot();
    const missing = join(root, 'missing-omp');

    await expect(
      createBootstrapProfileConfig({
        app: { id: 'cli_omp', secret: 'secret', tenant: 'feishu' },
        ompBinaryPath: missing,
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-binary-not-found',
        agentId: 'omp',
        agentName: 'Oh My Pi',
        command: missing,
        binaryPath: missing,
      },
    });
  });

  it('fails closed when a requested workspace is not a directory', async () => {
    const root = await makeRoot();
    const file = join(root, 'not-a-dir');
    const omp = await writeVersionExecutable(root, 'omp', 'omp 1.2.3');
    await writeFile(file, 'x', 'utf8');

    await expect(
      createBootstrapProfileConfig({
        app: { id: 'cli_omp', secret: 'secret', tenant: 'feishu' },
        workspace: file,
        ompBinaryPath: omp,
      }),
    ).rejects.toThrow(/路径不是目录/);
  });

  it('does not require a workspace', async () => {
    const root = await makeRoot();
    const omp = await writeVersionExecutable(root, 'omp', 'omp 1.2.3');

    await expect(
      createBootstrapProfileConfig({
        app: { id: 'cli_omp', secret: 'secret', tenant: 'feishu' },
        ompBinaryPath: omp,
      }),
    ).resolves.toMatchObject({ workspaces: {}, omp: { binaryPath: omp } });
  });
});
