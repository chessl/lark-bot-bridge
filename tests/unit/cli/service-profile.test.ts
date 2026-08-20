import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ServiceAdapter,
  ServiceRemoveResult,
  ServiceRestartResult,
  ServiceStartResult,
  ServiceStatus,
  ServiceStopResult,
} from '../../../src/daemon/service-adapter';
import type { ProcessEntry } from '../../../src/runtime/registry';

const mocks = vi.hoisted(() => ({
  adapter: undefined as unknown as ServiceAdapter,
  getServiceAdapter: vi.fn(),
  materializeEnvSecretForService: vi.fn(),
  resolveProfileRuntime: vi.fn(),
  readRegistry: vi.fn(),
  checkRuntimeLock: vi.fn(),
  stopProcessEntry: vi.fn(),
  readActiveProfile: vi.fn(),
  loadRootConfig: vi.fn(),
}));

vi.mock('../../../src/daemon/service-adapter', () => ({
  getServiceAdapter: mocks.getServiceAdapter,
}));

vi.mock('../../../src/runtime/profile-runtime', () => ({
  materializeEnvSecretForService: mocks.materializeEnvSecretForService,
  resolveProfileRuntime: mocks.resolveProfileRuntime,
}));

vi.mock('../../../src/runtime/registry', () => ({
  readRegistry: mocks.readRegistry,
}));

vi.mock('../../../src/runtime/locks', () => ({
  checkRuntimeLock: mocks.checkRuntimeLock,
}));

vi.mock('../../../src/cli/commands/ps', () => ({
  stopProcessEntry: mocks.stopProcessEntry,
}));

vi.mock('../../../src/config/profile-store', () => ({
  readActiveProfile: mocks.readActiveProfile,
  loadRootConfig: mocks.loadRootConfig,
}));

vi.mock('../../../src/config/app-paths', () => ({
  defaultAppPaths: {
    rootDir: '/tmp/lark-channel-home',
    configFile: '/tmp/lark-channel-home/config.json',
  },
}));

vi.mock('../../../src/daemon/paths', () => ({
  daemonStdoutPath: (profile: string) =>
    `/tmp/lark-channel-home/profiles/${profile}/logs/daemon/stdout.log`,
  daemonStderrPath: (profile: string) =>
    `/tmp/lark-channel-home/profiles/${profile}/logs/daemon/stderr.log`,
  SUPERVISOR_SERVICE_ID: 'supervisor',
}));

const {
  runServiceRestart,
  runServiceStart,
  runServiceStatus,
  runServiceStop,
  runServiceUnregister,
} = await import('../../../src/cli/commands/service');

describe('profile-aware service commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter = {
      status: vi.fn(
        (): ServiceStatus => ({
          state: 'inactive',
          platformName: 'mock',
          definitionPath: '/tmp/service',
        }),
      ),
      start: vi.fn(async (): Promise<ServiceStartResult> => ({ ok: true, replaced: false })),
      stop: vi.fn(
        async (): Promise<ServiceStopResult> => ({ ok: true, previousState: 'inactive' }),
      ),
      restart: vi.fn(
        async (): Promise<ServiceRestartResult> => ({ ok: true, action: 'started' }),
      ),
      remove: vi.fn(
        async (): Promise<ServiceRemoveResult> => ({
          ok: true,
          removed: true,
          previousState: 'inactive',
        }),
      ),
    };
    mocks.getServiceAdapter.mockReturnValue(mocks.adapter);
    mocks.materializeEnvSecretForService.mockResolvedValue(false);
    mocks.stopProcessEntry.mockResolvedValue('terminated');
    mocks.resolveProfileRuntime.mockResolvedValue({
      profile: 'codex-dev',
      configPath: '/tmp/lark-channel-home/config.json',
      appPaths: {
        profile: 'codex-dev',
        rootDir: '/tmp/lark-channel-home',
        profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/codex-dev.lock',
        appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
      },
      cfg: {
        accounts: {
          app: {
            id: 'cli_codex',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
        agentKind: 'codex',
      },
    });
    mocks.checkRuntimeLock.mockResolvedValue({ locked: false });
    mocks.readActiveProfile.mockResolvedValue('codex-dev');
    mocks.loadRootConfig.mockResolvedValue({
      profiles: {
        'codex-dev': {},
      },
    });
  });

  it('starts the OS service for the requested profile and reports the real agent', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    mocks.readRegistry.mockReturnValueOnce([]).mockReturnValue([
      processEntry({
        id: 'p1',
        pid: 12345,
        appId: 'cli_codex',
        profileName: 'codex-dev',
        agentKind: 'codex',
        botName: 'Codex Bot',
      }),
    ]);

    await runServiceStart({ profile: 'codex-dev' });

    // Classic per-profile service pins `run --profile <profile>`.
    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('codex-dev', [
      'run',
      '--profile',
      'codex-dev',
    ]);
    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        profile: 'codex-dev',
        agent: undefined,
        workspace: undefined,
        appId: undefined,
        appSecret: undefined,
        tenant: undefined,
        allowBootstrap: true,
      }),
    );
    expect(mocks.materializeEnvSecretForService).toHaveBeenCalledWith({ profile: 'codex-dev' });
    expect(mocks.adapter.start).toHaveBeenCalled();
    expect(lines).toContain(
      '✓ 已启动  bot: Codex Bot (cli_codex)  agent: Codex CLI (codex)  进程: p1',
    );
  });

  it('rejects start when the requested profile is already held by a foreground run', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    mocks.checkRuntimeLock.mockResolvedValue({
      locked: true,
      meta: {
        kind: 'profile',
        target: '/tmp/lark-channel-home/registry/locks/profile/codex-dev.lock',
        profile: 'codex-dev',
        agentKind: 'codex',
        pid: 2468,
        startedAt: '2026-05-26T10:50:33.082Z',
      },
    });
    mocks.readRegistry.mockReturnValueOnce([]).mockReturnValue([
      processEntry({
        id: 'p1',
        pid: 12345,
        appId: 'cli_codex',
        profileName: 'codex-dev',
        agentKind: 'codex',
        botName: 'Codex Bot',
      }),
    ]);

    await expect(runServiceStart({ profile: 'codex-dev' })).rejects.toThrow('exit:1');

    expect(mocks.adapter.start).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('当前 profile 已有 bridge 进程占用');
    expect(errors.join('\n')).toContain('pid=2468');

    exit.mockRestore();
  });


  it('allows start to replace the managed daemon that owns the runtime locks', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.adapter.status = vi.fn(
      (): ServiceStatus => ({
        state: 'running',
        pid: '2468',
        platformName: 'mock',
        definitionPath: '/tmp/service',
      }),
    );
    mocks.adapter.start = vi.fn(
      async (): Promise<ServiceStartResult> => ({ ok: true, replaced: true }),
    );
    mocks.checkRuntimeLock.mockResolvedValue({
      locked: true,
      meta: {
        kind: 'profile',
        target: '/tmp/lark-channel-home/registry/locks/profile/codex-dev.lock',
        profile: 'codex-dev',
        agentKind: 'codex',
        pid: 2468,
        startedAt: '2026-05-26T10:50:33.082Z',
      },
    });
    mocks.readRegistry.mockReturnValueOnce([]).mockReturnValue([
      processEntry({
        id: 'replacement',
        pid: 2469,
        appId: 'cli_codex',
        profileName: 'codex-dev',
        agentKind: 'codex',
        botName: 'Codex Bot',
      }),
    ]);

    await runServiceStart({ profile: 'codex-dev' });

    expect(mocks.adapter.start).toHaveBeenCalled();
    expect(mocks.stopProcessEntry).not.toHaveBeenCalled();
  });
  it('stops a foreground lock holder and continues service start after interactive confirmation', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    const holder = {
      kind: 'profile' as const,
      target: '/tmp/lark-channel-home/registry/locks/profile/codex-dev.lock',
      profile: 'codex-dev',
      agentKind: 'codex' as const,
      pid: 2468,
      startedAt: '2026-05-26T10:50:33.082Z',
    };
    mocks.checkRuntimeLock
      .mockResolvedValueOnce({ locked: true, meta: holder })
      .mockResolvedValueOnce({ locked: false })
      .mockResolvedValueOnce({ locked: false });
    mocks.readRegistry.mockReturnValueOnce([]).mockReturnValue([
      processEntry({
        id: 'p1',
        pid: 12345,
        appId: 'cli_codex',
        profileName: 'codex-dev',
        agentKind: 'codex',
        botName: 'Codex Bot',
      }),
    ]);

    await runServiceStart({
      profile: 'codex-dev',
      confirmStopRuntimeLockProcess: async () => true,
    });

    expect(mocks.stopProcessEntry).toHaveBeenCalledWith({ pid: 2468 });
    expect(mocks.adapter.start).toHaveBeenCalled();
    expect(lines).toContain('✓ 已停止 pid 2468');
  });

  it('rejects start when another profile already holds the same app lock', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    mocks.checkRuntimeLock.mockResolvedValueOnce({ locked: false }).mockResolvedValueOnce({
      locked: true,
      meta: {
        kind: 'app',
        target: '/tmp/lark-channel-home/registry/locks/app/cli_codex.lock',
        profile: 'codex-dev',
        agentKind: 'codex',
        appId: 'cli_codex',
        pid: 2468,
        startedAt: '2026-05-26T10:50:33.085Z',
      },
    });

    await expect(runServiceStart({ profile: 'codex-dev' })).rejects.toThrow('exit:1');

    expect(mocks.adapter.start).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('当前 app 已有 bridge 进程占用');
    expect(errors.join('\n')).toContain('app=cli_codex');

    exit.mockRestore();
  });

  it('lets start perform first-run bootstrap without requiring a profile concept', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.resolveProfileRuntime.mockResolvedValue({
      profile: 'claude',
      appPaths: {
        profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/claude.lock',
        appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
      },
      cfg: {
        accounts: {
          app: {
            id: 'cli_claude',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
        agentKind: 'claude',
      },
    });
    mocks.readRegistry.mockReturnValueOnce([]).mockReturnValue([
      processEntry({
        id: 'p2',
        pid: 12346,
        appId: 'cli_claude',
        profileName: 'claude',
        agentKind: 'claude',
        botName: 'Claude Bot',
      }),
    ]);

    await runServiceStart({
      agent: 'claude',
      workspace: '/repo',
      appId: 'cli_claude',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    });

    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        profile: undefined,
        agent: 'claude',
        workspace: '/repo',
        appId: 'cli_claude',
        appSecret: 'manual-secret',
        tenant: 'feishu',
        allowBootstrap: true,
      }),
    );
    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(2, {
      profile: 'claude',
      allowBootstrap: false,
    });
    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('claude', ['run', '--profile', 'claude']);
    expect(mocks.materializeEnvSecretForService).toHaveBeenCalledWith({ profile: 'claude' });
    expect(mocks.adapter.start).toHaveBeenCalled();
  });

  it('uses the active profile when --profile is omitted and fails if none exists', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.adapter.status = vi.fn(
      (): ServiceStatus => ({
        state: 'not-installed',
        platformName: 'mock',
        definitionPath: '/tmp/service',
      }),
    );

    await runServiceStatus();
    // Lifecycle commands (status/stop/restart/unregister) don't install, so
    // they pass no runArgs.
    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('codex-dev', undefined);

    mocks.readActiveProfile.mockResolvedValue(undefined);
    mocks.loadRootConfig.mockResolvedValue(undefined);
    await expect(runServiceStatus()).rejects.toThrow('active profile is required');
  });

  it('falls back to the supervisor service when the active profile has no service of its own', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    // Machine installed via `start --web-ui`: only the supervisor service
    // exists on disk, and it is the process hosting profile codex-dev.
    const supervisor = {
      ...mocks.adapter,
      status: vi.fn(
        (): ServiceStatus => ({
          state: 'running',
          pid: '12345',
          platformName: 'mock',
          definitionPath: '/tmp/supervisor',
        }),
      ),
      stop: vi.fn(
        async (): Promise<ServiceStopResult> => ({ ok: true, previousState: 'running' }),
      ),
    } as ServiceAdapter;
    mocks.getServiceAdapter.mockImplementation((serviceId: string) =>
      serviceId === 'supervisor'
        ? supervisor
        : {
            ...mocks.adapter,
            status: vi.fn(
              (): ServiceStatus => ({
                state: 'not-installed',
                platformName: 'mock',
                definitionPath: '/tmp/service',
              }),
            ),
          },
    );
    mocks.readRegistry.mockReturnValue([]);

    await runServiceStop();

    // Must act on the supervisor service, not silently no-op on a
    // per-profile service that was never installed.
    expect(supervisor.stop).toHaveBeenCalled();
    expect(lines.join('\n')).toContain('已指向控制面 supervisor 服务');
    expect(lines).toContain('✓ 控制面 supervisor 已停止运行');
  });

  it('turns off autostart when stopping a registered-but-not-running service', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });

    await runServiceStop({ profile: 'codex-dev' });

    expect(mocks.adapter.stop).toHaveBeenCalled();
    expect(lines).toContain('  已关闭开机自启。');
  });

  it('leaves an explicit --profile target alone even when a supervisor service exists', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    const supervisor = {
      ...mocks.adapter,
      status: vi.fn(
        (): ServiceStatus => ({
          state: 'running',
          platformName: 'mock',
          definitionPath: '/tmp/supervisor',
        }),
      ),
    } as ServiceAdapter;
    const classic = {
      ...mocks.adapter,
      status: vi.fn(
        (): ServiceStatus => ({
          state: 'not-installed',
          platformName: 'mock',
          definitionPath: '/tmp/service',
        }),
      ),
      stop: vi.fn(
        async (): Promise<ServiceStopResult> => ({ ok: true, previousState: 'not-installed' }),
      ),
    } as ServiceAdapter;
    mocks.getServiceAdapter.mockImplementation((serviceId: string) =>
      serviceId === 'supervisor' ? supervisor : classic,
    );

    await runServiceStop({ profile: 'codex-dev' });

    expect(supervisor.stop).not.toHaveBeenCalled();
    expect(classic.stop).toHaveBeenCalled();
    expect(lines).toContain('bot 还没在后台运行过,无需停止。');
  });

  it('allows cleanup of an explicitly named service after its profile was removed', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    mocks.loadRootConfig.mockResolvedValue({
      profiles: {
        claude: {},
      },
    });

    await runServiceStatus({ profile: 'codex-dev' });
    await runServiceUnregister({ profile: 'codex-dev' });

    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('codex-dev', undefined);
    expect(mocks.adapter.remove).toHaveBeenCalled();
    expect(lines).toContain('✓ 已清除后台运行注册');
    expect(lines).toContain('  (配置 / 日志 / 会话保留在 /tmp/lark-channel-home)');
  });

  it('runs the supervisor start lifecycle and preserves connection reporting', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
    mocks.readRegistry.mockReturnValueOnce([]).mockReturnValue([
      processEntry({
        id: 'supervised',
        pid: 5252,
        appId: 'cli_codex',
        profileName: 'codex-dev',
        agentKind: 'codex',
        botName: 'Supervisor Bot',
      }),
    ]);

    await runServiceStart({ webUi: true });

    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('supervisor', ['run', '--web-ui']);
    expect(mocks.adapter.start).toHaveBeenCalled();
    expect(lines.join('\n')).toContain('Supervisor Bot');
    expect(lines.join('\n')).toContain('控制台由后台 supervisor 托管');
  });

  it('starts an installed inactive classic daemon through restart', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
    mocks.readRegistry.mockReturnValueOnce([]).mockReturnValue([
      processEntry({
        id: 'restarted',
        pid: 6262,
        appId: 'cli_codex',
        profileName: 'codex-dev',
        agentKind: 'codex',
        botName: 'Restarted Bot',
      }),
    ]);

    await runServiceRestart({ profile: 'codex-dev' });

    expect(mocks.adapter.restart).toHaveBeenCalled();
    expect(lines.join('\n')).toContain('✓ 已启动  bot: Restarted Bot');
  });


  it('retains the corrective start error when restart was never installed', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => errors.push(String(line)));
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    mocks.adapter.restart = vi.fn(
      async (): Promise<ServiceRestartResult> => ({
        ok: false,
        reason: 'not-installed',
        operation: 'restart',
        stderr: '',
      }),
    );
    mocks.readRegistry.mockReturnValue([]);

    await expect(runServiceRestart({ profile: 'codex-dev' })).rejects.toThrow('exit:1');

    expect(errors.join('\n')).toContain('请先运行 `start`');
    exit.mockRestore();
  });
  it('reports a bounded stop timeout without duplicating stop polling', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => errors.push(String(line)));
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    mocks.adapter.stop = vi.fn(
      async (): Promise<ServiceStopResult> => ({
        ok: false,
        reason: 'stop-timeout',
        operation: 'stop',
        stderr: '',
      }),
    );

    await expect(runServiceStop({ profile: 'codex-dev' })).rejects.toThrow('exit:1');

    expect(mocks.adapter.stop).toHaveBeenCalledOnce();
    expect(errors.join('\n')).toContain('限定时间内停止');
    exit.mockRestore();
  });

  it('surfaces a structured platform failure from start', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => errors.push(String(line)));
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    mocks.adapter.start = vi.fn(
      async (): Promise<ServiceStartResult> => ({
        ok: false,
        reason: 'platform',
        operation: 'start',
        stderr: 'service manager unavailable',
      }),
    );
    mocks.readRegistry.mockReturnValue([]);

    await expect(runServiceStart({ profile: 'codex-dev' })).rejects.toThrow('exit:1');

    expect(errors.join('\n')).toContain('service manager unavailable');
    exit.mockRestore();
  });

  it('makes repeated supervisor removal observable and idempotent', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
    const remove = vi
      .fn<() => Promise<ServiceRemoveResult>>()
      .mockResolvedValueOnce({ ok: true, removed: true, previousState: 'running' })
      .mockResolvedValueOnce({ ok: true, removed: false, previousState: 'not-installed' });
    mocks.adapter.remove = remove;

    await runServiceUnregister({ webUi: true });
    await runServiceUnregister({ webUi: true });

    expect(remove).toHaveBeenCalledTimes(2);
    expect(lines).toContain('✓ 已清除后台运行注册');
    expect(lines).toContain('supervisor 还没在后台运行过,无需清理。');
  });

  it('reports and stops a running classic daemon through structured outcomes', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
    mocks.adapter.status = vi.fn(
      (): ServiceStatus => ({
        state: 'running',
        pid: '7373',
        lastExitCode: '0',
        platformName: 'mock',
        definitionPath: '/tmp/service',
      }),
    );
    mocks.adapter.stop = vi.fn(
      async (): Promise<ServiceStopResult> => ({ ok: true, previousState: 'running' }),
    );
    mocks.readRegistry.mockReturnValue([
      processEntry({
        pid: 7373,
        appId: 'cli_codex',
        profileName: 'codex-dev',
        botName: 'Classic Bot',
      }),
    ]);

    await runServiceStatus({ profile: 'codex-dev' });
    await runServiceStop({ profile: 'codex-dev' });

    expect(lines.join('\n')).toContain('Classic Bot (cli_codex) 正在后台运行');
    expect(lines.join('\n')).toContain('进程 ID: 7373');
    expect(lines.join('\n')).toContain('✓ bot Classic Bot (cli_codex) 已停止运行');
  });

  it('reports and restarts a running supervisor through structured outcomes', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
    mocks.adapter.status = vi.fn(
      (): ServiceStatus => ({
        state: 'running',
        pid: '8383',
        platformName: 'mock',
        definitionPath: '/tmp/supervisor',
      }),
    );
    mocks.adapter.restart = vi.fn(
      async (): Promise<ServiceRestartResult> => ({ ok: true, action: 'restarted' }),
    );
    const online = processEntry({
      id: 'before-restart',
      pid: 8383,
      appId: 'cli_codex',
      profileName: 'codex-dev',
      botName: 'Supervisor Bot',
    });
    mocks.readRegistry.mockReturnValue([online]);

    await runServiceStatus({ webUi: true });

    mocks.readRegistry.mockReset();
    mocks.readRegistry.mockReturnValueOnce([]).mockReturnValue([
      { ...online, id: 'after-restart', pid: 8484 },
    ]);
    await runServiceRestart({ webUi: true });

    expect(lines.join('\n')).toContain('控制面 supervisor 正在后台运行');
    expect(lines.join('\n')).toContain('✓ 已重启  bot: Supervisor Bot');
    expect(mocks.adapter.restart).toHaveBeenCalled();
  });
});

function processEntry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'id',
    pid: process.pid,
    appId: 'cli_test',
    tenant: 'feishu',
    profileName: 'claude',
    agentKind: 'claude',
    configPath: '/tmp/config.json',
    startedAt: new Date().toISOString(),
    version: '0.1.32',
    ...overrides,
  };
}
