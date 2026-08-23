import { createInterface } from 'node:readline';
import { defaultAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { isComplete } from '../../config/schema';
import { daemonStderrPath, daemonStdoutPath, SUPERVISOR_SERVICE_ID } from '../../daemon/paths';
import {
  getServiceAdapter,
  type ServiceAdapter,
  type ServiceFailure,
  type ServiceRestartResult,
  type ServiceStartResult,
} from '../../daemon/service-adapter';
import { checkRuntimeLock, type RuntimeLockMeta } from '../../runtime/locks';
import {
  materializeEnvSecretForService,
  resolveProfileRuntime,
} from '../../runtime/profile-runtime';
import { type ProcessEntry, readRegistry } from '../../runtime/registry';
import { type StopProcessEntryResult, stopProcessEntry } from './ps';

export interface ServiceStartOptions {
  profile?: string;
  workspace?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  /** Install the supervisor+console service (`run --web-ui`) instead of a
   * single-profile service. */
  webUi?: boolean;
  confirmStopRuntimeLockProcess?: (meta: RuntimeLockMeta) => boolean | Promise<boolean>;
  stopRuntimeLockProcess?: (
    meta: RuntimeLockMeta,
  ) => StopProcessEntryResult | Promise<StopProcessEntryResult>;
}

export interface ServiceProfileOptions {
  profile?: string;
  /** Target the machine-wide supervisor service instead of a per-profile one. */
  webUi?: boolean;
}

/** CLI args a classic per-profile daemon launches with. Pinning `--profile`
 * keeps the service tied to its profile even if the active profile changes. */
function classicRunArgs(profile: string): string[] {
  return ['run', '--profile', profile];
}

/** CLI args the supervisor+console daemon launches with. */
const WEB_UI_RUN_ARGS = ['run', '--web-ui'];

/**
 * Resolve which OS service a lifecycle command (stop/restart/status/unregister)
 * targets: the machine-wide supervisor service (`--web-ui`) or a per-profile
 * classic one. `profile` is only set in the classic case (for botName lookup).
 */
async function resolveServiceTarget(
  opts: ServiceProfileOptions,
): Promise<{ serviceId: string; profile?: string; webUi: boolean }> {
  if (opts.webUi) return { serviceId: SUPERVISOR_SERVICE_ID, webUi: true };
  const profile = await resolveServiceProfile(opts.profile);
  // `start --web-ui` installs ONE supervisor-keyed service that hosts every
  // profile in a single process — there is no per-profile service to act on.
  // Without this fallback, a plain `stop` looks up a service that was never
  // installed and cheerfully reports "还没在后台运行过" while the supervisor
  // (and this profile inside it) is very much running, and launchd's KeepAlive
  // keeps respawning it after every `kill`. An explicit `--profile` is left
  // alone: the user asked for that per-profile service, not the machine-wide one.
  if (!opts.profile && !serviceFileExists(profile) && serviceFileExists(SUPERVISOR_SERVICE_ID)) {
    console.log(
      `ℹ profile「${profile}」没有独立的后台服务,已指向控制面 supervisor 服务(等同 --web-ui)。`,
    );
    return { serviceId: SUPERVISOR_SERVICE_ID, webUi: true };
  }
  return { serviceId: profile, profile, webUi: false };
}

/** Whether this platform has a service definition on disk for `serviceId`. */
function serviceFileExists(serviceId: string): boolean {
  return getServiceAdapter(serviceId)?.status().state !== 'not-installed';
}

/** Find the live registry entry (with botName) for a classic profile, if any. */
async function lookupProfileEntry(profile: string): Promise<ProcessEntry | undefined> {
  const runtime = await maybeResolveProfileRuntime(profile);
  const appId = runtime?.cfg.accounts?.app?.id;
  if (!appId) return undefined;
  return readRegistry().find(
    (e) => e.appId === appId && e.profileName === profile && Boolean(e.botName),
  );
}

/**
 * Resolve the adapter for the current platform, or exit with a helpful
 * message. All service-level commands gate on this.
 */
function requireAdapter(cmdName: string, serviceId: string, runArgs?: string[]): ServiceAdapter {
  const adapter = getServiceAdapter(serviceId, runArgs);
  if (!adapter) {
    console.error(`${cmdName}: 当前系统不支持后台运行。`);
    console.error('  目前支持: macOS (launchd) / Linux (systemd)');
    process.exit(1);
  }
  return adapter;
}

/**
 * Strip the misleading "Try re-running the command as root for richer
 * errors" line that launchctl always appends — it's incorrect for our
 * per-user LaunchAgents domain. Running as root targets a different
 * domain (system-wide) and won't even see our plist.
 */
function formatServiceStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !/re-running the command as root/i.test(line))
    .join('\n')
    .trim();
}

/**
 * Map common failure patterns to Chinese-language hints. Falls through
 * to the raw stderr (with platform-specific noise stripped) so power
 * users can still see the underlying problem.
 */
function printServiceFailure(verb: 'started' | 'restarted', stderr: string): void {
  const cleaned = formatServiceStderr(stderr);
  const action = verb === 'started' ? '启动' : '重启';

  if (/bootstrap failed.*input\/output error/i.test(cleaned)) {
    console.error(`✗ bot ${action}失败。`);
    console.error('');
    console.error('最常见原因:旧的 bot 实例还在收尾。请试以下任一种:');
    console.error('  1. 稍等几秒,重新运行 `start`');
    console.error('  2. 或彻底清除注册再启动:');
    console.error('       unregister');
    console.error('       start');
    console.error('');
    console.error('原始错误:');
    console.error(`  ${cleaned}`);
    return;
  }

  console.error(`✗ bot ${action}失败:`);
  console.error(cleaned);
}

async function ensureBridgeConfigured(
  opts: ServiceStartOptions,
): Promise<
  Pick<
    Awaited<ReturnType<typeof resolveProfileRuntime>>,
    'profile' | 'cfg' | 'profileConfig' | 'appPaths' | 'configPath'
  >
> {
  const { cfg, profile, profileConfig, appPaths, configPath } = await resolveProfileRuntime({
    profile: opts.profile,
    workspace: opts.workspace,
    appId: opts.appId,
    appSecret: opts.appSecret,
    tenant: opts.tenant,
    allowBootstrap: true,
  });
  if (!isComplete(cfg)) {
    console.error('bot 还没配置 app 凭据。');
    console.error('请重新运行 `start` 完成首次扫码向导或传入已有应用信息。');
    process.exit(1);
  }
  return { profile, cfg, profileConfig, appPaths, configPath };
}

async function assertLockNotHeldByAnotherRuntime(
  kind: 'profile' | 'app',
  target: string,
  adapter: ServiceAdapter,
  opts: Pick<ServiceStartOptions, 'confirmStopRuntimeLockProcess' | 'stopRuntimeLockProcess'> = {},
): Promise<void> {
  for (;;) {
    const lock = await checkRuntimeLock(target);
    if (!lock.locked) return;

    const status = adapter.status();
    const servicePid = status.state === 'running' ? status.pid : undefined;
    if (servicePid && lock.meta?.pid === Number(servicePid)) return;

    console.error(`✗ 当前 ${kind === 'profile' ? 'profile' : 'app'} 已有 bridge 进程占用。`);
    if (!lock.meta) {
      console.error(`  lock: ${target}`);
      console.error('  请先停止正在运行的占用进程，再执行 start。');
      process.exit(1);
    }
    const app = lock.meta.appId ? ` app=${lock.meta.appId}` : '';
    console.error(
      `  holder: profile=${lock.meta.profile}${app} pid=${lock.meta.pid} startedAt=${lock.meta.startedAt}`,
    );

    if (!opts.confirmStopRuntimeLockProcess && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      console.error(
        `  非交互模式无法确认停止 ${kind === 'profile' ? 'profile' : 'app'} 占用进程。` +
          '请先用 `lark-bot-bridge ps` 查看并用 `lark-bot-bridge kill <bot id>` 停止后重试。',
      );
      process.exit(1);
    }

    const confirmed = opts.confirmStopRuntimeLockProcess
      ? await opts.confirmStopRuntimeLockProcess(lock.meta)
      : await confirmStopRuntimeLockProcess();
    if (!confirmed) {
      console.log('已取消启动。');
      process.exit(0);
    }

    const result = opts.stopRuntimeLockProcess
      ? await opts.stopRuntimeLockProcess(lock.meta)
      : await stopProcessEntry({ pid: lock.meta.pid });
    if (result === 'killed') {
      console.log(`✓ 已强制停止 pid ${lock.meta.pid}`);
    } else {
      console.log(`✓ 已停止 pid ${lock.meta.pid}`);
    }
  }
}

async function confirmStopRuntimeLockProcess(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question('是否停止旧进程并继续启动后台服务? [y/N]: ', resolve),
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Poll `~/.lark-bot-bridge/registry/processes.json` for a freshly-registered bridge
 * instance whose appId matches our config and whose `botName` is filled —
 * the latter only happens AFTER the WS handshake to Feishu succeeds, so
 * by the time we see it the daemon is genuinely online.
 *
 * `beforePids` is the set of pids already running before we kicked off
 * the start/restart; we exclude them so the previous daemon instance
 * (in restart scenarios, briefly) or a separate foreground `run` doesn't
 * get misreported as our newly-spawned one.
 */
async function waitForServiceConnect(
  appId: string,
  profile: string,
  beforePids: ReadonlySet<number>,
  timeoutMs = 30_000,
): Promise<ProcessEntry | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = readRegistry();
    const fresh = live.find(
      (e) =>
        e.appId === appId &&
        e.profileName === profile &&
        !beforePids.has(e.pid) &&
        Boolean(e.botName),
    );
    if (fresh) return fresh;
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

/**
 * Snapshot current pids for this app + invoke the OS service action +
 * wait for a fresh registry entry, then print the same connection line
 * `run` uses. Used by both `start` and `restart`.
 */
async function reportConnectAfter(
  operation: 'start' | 'restart',
  target: 'bot' | 'supervisor',
  profile: string,
  adapter: ServiceAdapter,
): Promise<void> {
  const { cfg } = await resolveProfileRuntime({ profile, allowBootstrap: false });
  const appId = cfg.accounts?.app?.id ?? '';
  const beforePids = new Set(
    readRegistry()
      .filter((e) => e.appId === appId && e.profileName === profile)
      .map((e) => e.pid),
  );

  const result: ServiceStartResult | ServiceRestartResult =
    operation === 'start' ? await adapter.start() : await adapter.restart();
  if (!result.ok) {
    printLifecycleFailure(result, operation, target);
    process.exit(1);
  }

  if (operation === 'start' && 'replaced' in result && result.replaced) {
    console.log(
      target === 'supervisor'
        ? '检测到 supervisor 服务已在运行,先停掉再重启...'
        : '检测到旧 bot 实例,先停掉再重启...',
    );
    if (result.stopWarning) {
      const label = target === 'supervisor' ? '旧 supervisor' : '旧实例';
      console.warn(`⚠ 停止${label}时有警告(继续重启):\n${formatServiceStderr(result.stopWarning)}`);
    }
  }

  const verb = operation === 'restart' && 'action' in result ? result.action : ('started' as const);
  console.log(verb === 'started' ? '正在等待 bot 连接...' : '正在等待 bot 重新连接...');
  const entry = await waitForServiceConnect(appId, profile, beforePids);
  if (entry) {
    const verbZh = verb === 'started' ? '已启动' : '已重启';
    console.log(
      `✓ ${verbZh}  bot: ${entry.botName} (${entry.appId})  engine: Oh My Pi (omp)  进程: ${entry.id}`,
    );
    return;
  }
  console.warn(`⚠ 已下发指令,但 30 秒内未观察到 bot 连接成功 (${verb})。`);
  console.warn(`  查看日志: tail -f ${daemonStderrPath(profile)}`);
  console.warn(`              tail -f ${daemonStdoutPath(profile)}`);
}

function printLifecycleFailure(
  failure: ServiceFailure,
  operation: 'start' | 'restart',
  target: 'bot' | 'supervisor',
): void {
  if (failure.reason === 'not-installed') {
    console.error(
      target === 'supervisor'
        ? 'supervisor 还没在后台运行过。请先运行 `start --web-ui` 启动。'
        : 'bot 还没在后台运行过。请先运行 `start` 启动。',
    );
    return;
  }
  if (failure.reason === 'stop-timeout') {
    const label = target === 'supervisor' ? '旧 supervisor 服务' : '旧 bot 实例';
    const flag = target === 'supervisor' ? ' --web-ui' : '';
    console.error(`✗ ${label}没有完全停止。请稍后重试,或:`);
    console.error(`  unregister${flag}  # 强制清除注册`);
    console.error(`  start${flag}       # 再次启动`);
    return;
  }
  const verb = operation === 'start' || failure.operation === 'start' ? 'started' : 'restarted';
  printServiceFailure(verb, failure.stderr);
}

/**
 * `bridge start` — install (write file + reload) then start.
 *
 * Always re-installs so that `process.execPath` (current node binary)
 * and `process.env.PATH` reflect the user's current shell — important if
 * they've switched runtime versions or updated their PATH since last install.
 */
export async function runServiceStart(opts: ServiceStartOptions = {}): Promise<void> {
  if (opts.webUi) {
    await runServiceStartWebUi(opts);
    return;
  }
  const { profile, cfg, appPaths } = await ensureBridgeConfigured(opts);
  const adapter = requireAdapter('start', profile, classicRunArgs(profile));
  await assertLockNotHeldByAnotherRuntime('profile', appPaths.profileLockFile, adapter, opts);
  await assertLockNotHeldByAnotherRuntime(
    'app',
    appPaths.appLockFile(cfg.accounts.app.id),
    adapter,
    opts,
  );
  await materializeEnvSecretForService({ profile });
  await reportConnectAfter('start', 'bot', profile, adapter);
}

/**
 * `bridge start --web-ui` — install + start the machine-wide supervisor+console
 * service. The daemon runs `run --web-ui`, which hosts every profile in one
 * process and serves the local web console. We preflight the active profile in
 * this TTY (the daemon's own run is non-interactive), install a single
 * supervisor-keyed service, then wait for the active profile to connect as a
 * health signal.
 *
 * Note: unlike classic start, we do NOT block on per-profile/app runtime locks
 * — the supervisor tolerates an individual profile failing to come online and
 * simply shows it offline in the console.
 */
async function runServiceStartWebUi(opts: ServiceStartOptions): Promise<void> {
  const { profile } = await ensureBridgeConfigured(opts);
  const adapter = requireAdapter('start', SUPERVISOR_SERVICE_ID, WEB_UI_RUN_ARGS);
  await materializeEnvSecretForService({ profile });
  await reportConnectAfter('start', 'supervisor', profile, adapter);
  console.log('  控制台由后台 supervisor 托管；用 `lark-bot-bridge ui` 打开');
}

/** `bridge stop` — stop now and prevent auto-start after login or reboot. */
export async function runServiceStop(opts: ServiceProfileOptions = {}): Promise<void> {
  const { serviceId, profile, webUi } = await resolveServiceTarget(opts);
  const adapter = requireAdapter('stop', serviceId);
  const entry = !webUi && profile ? await lookupProfileEntry(profile) : undefined;
  const result = await adapter.stop();
  if (!result.ok) {
    console.error(
      result.reason === 'stop-timeout'
        ? '✗ 停止指令已下发,但服务没有在限定时间内停止。'
        : `✗ 停止失败:\n${formatServiceStderr(result.stderr)}`,
    );
    process.exit(1);
  }
  if (result.previousState === 'not-installed') {
    console.log(
      webUi ? 'supervisor 还没在后台运行过,无需停止。' : 'bot 还没在后台运行过,无需停止。',
    );
    return;
  }
  if (result.previousState === 'inactive') {
    console.log(webUi ? 'supervisor 当前没在后台运行。' : 'bot 当前没在后台运行。');
    console.log('  已关闭开机自启。');
    return;
  }
  if (webUi) {
    console.log('✓ 控制面 supervisor 已停止运行');
    console.log('  通过 `start --web-ui` 可再次重启');
    return;
  }
  console.log(entry ? `✓ bot ${entry.botName} (${entry.appId}) 已停止运行` : '✓ bot 已停止运行');
  console.log('  通过 `start` 可再次重启');
}

/**
 * `bridge restart` — restart a running daemon or start an installed inactive
 * daemon. A never-installed daemon retains the corrective `start` error.
 */
export async function runServiceRestart(opts: ServiceProfileOptions = {}): Promise<void> {
  const { serviceId, webUi } = await resolveServiceTarget(opts);
  const adapter = requireAdapter(
    'restart',
    serviceId,
    webUi ? WEB_UI_RUN_ARGS : classicRunArgs(serviceId),
  );
  const waitProfile = webUi ? await resolveServiceProfile(undefined) : serviceId;
  await reportConnectAfter('restart', webUi ? 'supervisor' : 'bot', waitProfile, adapter);
}

/** `bridge status` — report whether the daemon is running, with pid + log paths. */
export async function runServiceStatus(opts: ServiceProfileOptions = {}): Promise<void> {
  const { serviceId, profile, webUi } = await resolveServiceTarget(opts);
  const adapter = requireAdapter('status', serviceId);
  const status = adapter.status();
  const startHint = webUi ? '`start --web-ui`' : '`start`';
  const label = webUi ? '控制面 supervisor' : 'bot';
  if (status.state === 'not-installed') {
    console.log(`${label} 当前没在后台运行(从未启动过)`);
    console.log(`  通过 ${startHint} 启动`);
    return;
  }
  if (status.state === 'inactive') {
    console.log(`${label} 当前没在后台运行`);
    console.log(`  通过 ${startHint} 重新启动`);
    console.log(`  服务定义: ${status.definitionPath}`);
    if (status.lastExitCode && status.lastExitCode !== '-1') {
      console.log(`  上次退出码: ${status.lastExitCode}`);
    }
    return;
  }

  const entry = !webUi && profile ? await lookupProfileEntry(profile) : undefined;
  if (webUi) {
    console.log('✓ 控制面 supervisor 正在后台运行');
    const online = readRegistry().filter((e) => Boolean(e.botName));
    if (online.length) console.log(`  在线 bot: ${online.map((e) => e.botName).join('、')}`);
  } else if (entry) {
    console.log(`✓ bot ${entry.botName} (${entry.appId}) 正在后台运行`);
  } else {
    console.log('✓ bot 正在后台运行');
  }
  if (status.pid) console.log(`  进程 ID: ${status.pid}`);
  console.log(`  服务: ${status.platformName}`);
  console.log(`  定义: ${status.definitionPath}`);
  console.log('  日志:');
  console.log(`    ${daemonStdoutPath(serviceId)}`);
  console.log(`    ${daemonStderrPath(serviceId)}`);
  if (status.lastExitCode && status.lastExitCode !== '-1') {
    console.log(`  上次退出码: ${status.lastExitCode}`);
  }
}

/**
 * `bridge unregister` — stop, disable autostart, and remove the service
 * definition file.
 *
 * Idempotent. Leaves ~/.lark-bot-bridge/ state untouched (keystore, sessions,
 * logs etc) — that's the user's data, not service-manager hooks.
 */
export async function runServiceUnregister(opts: ServiceProfileOptions = {}): Promise<void> {
  const { serviceId, webUi } = await resolveServiceTarget(opts);
  const adapter = requireAdapter('unregister', serviceId);
  const label = webUi ? 'supervisor' : 'bot';
  const result = await adapter.remove();
  if (!result.ok) {
    console.error(
      result.reason === 'stop-timeout'
        ? `✗ ${label} 没有在限定时间内停止,未清除注册。`
        : `✗ 清理 ${label} 失败:\n${formatServiceStderr(result.stderr)}`,
    );
    process.exit(1);
  }
  if (!result.removed) {
    console.log(`${label} 还没在后台运行过,无需清理。`);
    return;
  }
  if (result.previousState === 'running') console.log(`✓ 已停止 ${label}`);
  console.log('✓ 已清除后台运行注册');
  console.log(`  (配置 / 日志 / 会话保留在 ${defaultAppPaths.rootDir})`);
}

async function resolveServiceProfile(explicitProfile: string | undefined): Promise<string> {
  if (explicitProfile) return explicitProfile;
  const root = await loadRootConfig(defaultAppPaths.configFile);
  const profile = (await readActiveProfile(defaultAppPaths.rootDir)) ?? root?.activeProfile;
  if (!profile) {
    throw new Error('active profile is required for service command; pass --profile <name>');
  }
  if (root && !root.profiles[profile]) throw new Error(`profile not found: ${profile}`);
  return profile;
}

async function maybeResolveProfileRuntime(
  profile: string,
): Promise<Awaited<ReturnType<typeof resolveProfileRuntime>> | undefined> {
  try {
    return await resolveProfileRuntime({ profile, allowBootstrap: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/profile not found|config not initialized|active profile is required/i.test(message)) {
      return undefined;
    }
    throw err;
  }
}
