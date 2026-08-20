import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  mkdir: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  spawnSync: vi.fn((_bin: string, _args: string[], _options?: unknown) => ({
    status: 0,
    stdout: '',
    stderr: '',
  })),
  writeFile: vi.fn(async () => {}),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: mocks.spawnSync,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: mocks.existsSync,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir: mocks.mkdir,
  rm: mocks.rm,
  writeFile: mocks.writeFile,
}));

const { getServiceAdapter } = await import('../../../src/daemon/service-adapter');
const realPlatform = process.platform;

function forcePlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function callsFor(binary: string): string[] {
  return mocks.spawnSync.mock.calls
    .filter(([candidate]) => candidate === binary)
    .map(([, args]) => args.join(' '));
}

describe('structured platform daemon lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  afterAll(() => forcePlatform(realPlatform));

  it('translates launchd inactive stop into persistent autostart disable', async () => {
    forcePlatform('darwin');
    mocks.spawnSync.mockImplementation((_binary, args, options) => ({
      status: args[0] === 'print' && 'stdio' in (options as object) ? 1 : 0,
      stdout: '',
      stderr: '',
    }));

    const result = await getServiceAdapter('supervisor')?.stop();

    expect(result).toEqual({ ok: true, previousState: 'inactive' });
    expect(callsFor('launchctl')).toEqual([
      expect.stringMatching(/^print gui\/\d+\//),
      expect.stringMatching(/^disable gui\/\d+\//),
    ]);
  });

  it('translates launchd replacement start and returns structured status', async () => {
    forcePlatform('darwin');
    let loadedChecks = 0;
    mocks.spawnSync.mockImplementation((_binary, args, options) => {
      if (args[0] === 'print' && 'stdio' in (options as object)) {
        loadedChecks += 1;
        return { status: loadedChecks === 1 ? 0 : 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'print') {
        return { status: 0, stdout: 'pid = 4321\nlast exit code = 7', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const adapter = getServiceAdapter('supervisor', ['run', '--web-ui']);
    const status = adapter?.status();
    loadedChecks = 0;
    const result = await adapter?.start();

    expect(status).toEqual(
      expect.objectContaining({
        state: 'running',
        pid: '4321',
        lastExitCode: '7',
        platformName: 'launchd (macOS)',
      }),
    );
    expect(result).toEqual({ ok: true, replaced: true });
    expect(callsFor('launchctl')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^bootout /),
        expect.stringMatching(/^enable /),
        expect.stringMatching(/^bootstrap /),
      ]),
    );
  });

  it('translates systemd install, inactive start, and metadata refresh', async () => {
    forcePlatform('linux');
    mocks.spawnSync.mockImplementation((_binary, args) => {
      if (args.includes('is-active')) return { status: 3, stdout: 'inactive', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = await getServiceAdapter('codex-dev', ['run', '--profile', 'codex-dev'])?.start();

    expect(result).toEqual({ ok: true, replaced: false });
    expect(callsFor('systemctl')).toEqual(
      expect.arrayContaining([
        '--user daemon-reload',
        expect.stringMatching(/^--user enable --now /),
      ]),
    );
  });

  it('translates systemd status and makes removal idempotent', async () => {
    forcePlatform('linux');
    mocks.spawnSync.mockImplementation((_binary, args) => {
      if (args.includes('is-active')) return { status: 3, stdout: 'inactive', stderr: '' };
      if (args.includes('status')) {
        return {
          status: 3,
          stdout: 'Process: 998 ExecStart=/bridge status=9\nMain PID: 998',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const adapter = getServiceAdapter('codex-dev');

    expect(adapter?.status()).toEqual(
      expect.objectContaining({ state: 'inactive', pid: '998', lastExitCode: '9' }),
    );
    expect(await adapter?.remove()).toEqual({
      ok: true,
      removed: true,
      previousState: 'inactive',
    });
    mocks.existsSync.mockReturnValue(false);
    expect(await adapter?.remove()).toEqual({
      ok: true,
      removed: false,
      previousState: 'not-installed',
    });
    expect(mocks.rm).toHaveBeenCalledTimes(2);
    expect(callsFor('systemctl')).toContain(
      '--user disable lark-bot-bridge.bot.codex-dev.service',
    );
    expect(callsFor('systemctl').filter((call) => call === '--user daemon-reload')).toHaveLength(2);
  });

  it('returns platform failures without exposing raw command operations', async () => {
    forcePlatform('linux');
    mocks.spawnSync.mockImplementation((_binary, args) => ({
      status: args.includes('daemon-reload') ? 1 : args.includes('is-active') ? 3 : 0,
      stdout: '',
      stderr: args.includes('daemon-reload') ? 'reload failed' : '',
    }));

    const result = await getServiceAdapter('codex-dev')?.start();
    expect(result).toEqual({
      ok: false,
      reason: 'platform',
      operation: 'install',
      stderr: 'reload failed',
    });
  });
});
