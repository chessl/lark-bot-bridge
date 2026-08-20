import { defaultAppPaths } from '../config/app-paths';
import * as launchd from './launchd';
import { launchAgentPlistPath, systemdUnitPath } from './paths';
import * as systemd from './systemd';

interface PlatformResult {
  ok: boolean;
  stderr: string;
}

interface PlatformStatus {
  pid?: string;
  lastExitCode?: string;
}

interface PlatformAdapter {
  readonly platformName: string;
  readonly definitionPath: string;
  definitionExists(): boolean;
  isRunning(): boolean;
  install(): Promise<PlatformResult>;
  start(): PlatformResult;
  stop(): PlatformResult;
  stopAndDisableAutostart(): PlatformResult;
  disableAutostart(): PlatformResult;
  restart(): PlatformResult;
  waitUntilStopped(timeoutMs?: number): Promise<boolean>;
  remove(): Promise<PlatformResult>;
  status(): PlatformStatus;
}

export type ServiceState = 'not-installed' | 'inactive' | 'running';

export interface ServiceStatus extends PlatformStatus {
  state: ServiceState;
  definitionPath: string;
  platformName: string;
}

export interface ServiceFailure {
  ok: false;
  reason: 'not-installed' | 'platform' | 'stop-timeout';
  operation: 'install' | 'start' | 'stop' | 'disable' | 'restart' | 'remove';
  stderr: string;
}

export interface ServiceStartSuccess {
  ok: true;
  replaced: boolean;
  stopWarning?: string;
}

export interface ServiceStopSuccess {
  ok: true;
  previousState: ServiceState;
}

export interface ServiceRestartSuccess {
  ok: true;
  action: 'started' | 'restarted';
}

export interface ServiceRemoveSuccess {
  ok: true;
  removed: boolean;
  previousState: ServiceState;
}

export type ServiceStartResult = ServiceStartSuccess | ServiceFailure;
export type ServiceStopResult = ServiceStopSuccess | ServiceFailure;
export type ServiceRestartResult = ServiceRestartSuccess | ServiceFailure;
export type ServiceRemoveResult = ServiceRemoveSuccess | ServiceFailure;

/** Platform-independent daemon lifecycle. Raw OS operations never cross this seam. */
export interface ServiceAdapter {
  status(): ServiceStatus;
  start(): Promise<ServiceStartResult>;
  stop(): Promise<ServiceStopResult>;
  restart(): Promise<ServiceRestartResult>;
  remove(): Promise<ServiceRemoveResult>;
}

function makeServiceAdapter(platform: PlatformAdapter): ServiceAdapter {
  const currentState = (): ServiceState =>
    !platform.definitionExists() ? 'not-installed' : platform.isRunning() ? 'running' : 'inactive';
  const status = (): ServiceStatus => {
    const state = currentState();
    return {
      state,
      definitionPath: platform.definitionPath,
      platformName: platform.platformName,
      ...(state === 'not-installed' ? {} : platform.status()),
    };
  };

  return {
    status,
    async start() {
      let operation: ServiceFailure['operation'] = 'install';
      try {
        const replaced = currentState() === 'running';
        const installed = await platform.install();
        if (!installed.ok) return failure('install', installed.stderr);
        let stopWarning: string | undefined;
        if (replaced) {
          operation = 'stop';
          const stopped = platform.stop();
          if (!stopped.ok) stopWarning = stopped.stderr;
          if (!(await platform.waitUntilStopped())) return timeoutFailure();
        }
        operation = 'start';
        const started = platform.start();
        return started.ok
          ? { ok: true, replaced, ...(stopWarning ? { stopWarning } : {}) }
          : failure('start', started.stderr);
      } catch (error) {
        return failure(operation, errorMessage(error));
      }
    },
    async stop() {
      let operation: ServiceFailure['operation'] = 'stop';
      try {
        const previousState = currentState();
        if (previousState === 'not-installed') return { ok: true, previousState };
        operation = previousState === 'running' ? 'stop' : 'disable';
        const stopped =
          previousState === 'running'
            ? platform.stopAndDisableAutostart()
            : platform.disableAutostart();
        if (!stopped.ok) return failure(operation, stopped.stderr);
        if (previousState === 'running' && !(await platform.waitUntilStopped())) {
          return timeoutFailure();
        }
        return { ok: true, previousState };
      } catch (error) {
        return failure(operation, errorMessage(error));
      }
    },
    async restart() {
      let operation: ServiceFailure['operation'] = 'restart';
      try {
        const state = currentState();
        if (state === 'not-installed') {
          return { ok: false, reason: 'not-installed', operation, stderr: '' };
        }
        operation = state === 'running' ? 'restart' : 'start';
        const restarted = state === 'running' ? platform.restart() : platform.start();
        return restarted.ok
          ? { ok: true, action: state === 'running' ? 'restarted' : 'started' }
          : failure(operation, restarted.stderr);
      } catch (error) {
        return failure(operation, errorMessage(error));
      }
    },
    async remove() {
      let operation: ServiceFailure['operation'] = 'stop';
      try {
        const state = currentState();
        if (state !== 'not-installed') {
          operation = state === 'running' ? 'stop' : 'disable';
          const stopped =
            state === 'running'
              ? platform.stopAndDisableAutostart()
              : platform.disableAutostart();
          if (!stopped.ok) return failure(operation, stopped.stderr);
          if (state === 'running' && !(await platform.waitUntilStopped())) return timeoutFailure();
        }
        operation = 'remove';
        const removed = await platform.remove();
        return removed.ok
          ? { ok: true, removed: state !== 'not-installed', previousState: state }
          : failure('remove', removed.stderr);
      } catch (error) {
        return failure(operation, errorMessage(error));
      }
    },
  };
}

function failure(operation: ServiceFailure['operation'], stderr: string): ServiceFailure {
  return { ok: false, reason: 'platform', operation, stderr };
}

function timeoutFailure(): ServiceFailure {
  return { ok: false, reason: 'stop-timeout', operation: 'stop', stderr: '' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeLaunchdAdapter(profile: string, runArgs: string[]): ServiceAdapter {
  return makeServiceAdapter({
    platformName: 'launchd (macOS)',
    definitionPath: launchAgentPlistPath(profile),
    definitionExists: () => launchd.plistExists(profile),
    isRunning: () => launchd.isLoaded(profile),
    install: async () => {
      await launchd.writePlist(profile, runArgs);
      return { ok: true, stderr: '' };
    },
    start: () => {
      const enabled = launchd.enable(profile);
      return enabled.ok ? launchd.bootstrap(profile) : enabled;
    },
    stop: () => launchd.bootout(profile),
    stopAndDisableAutostart: () => {
      const stopped = launchd.bootout(profile);
      const disabled = launchd.disable(profile);
      return stopped.ok ? disabled : stopped;
    },
    disableAutostart: () => launchd.disable(profile),
    restart: () => launchd.kickstart(profile),
    waitUntilStopped: (timeoutMs) => launchd.waitUntilUnloaded(profile, timeoutMs),
    remove: async () => {
      await launchd.deletePlist(profile);
      return { ok: true, stderr: '' };
    },
    status: () => {
      const text = launchd.describeService(profile);
      return {
        pid: text.match(/pid\s*=\s*(\d+)/)?.[1],
        lastExitCode: text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1],
      };
    },
  });
}

function makeSystemdAdapter(profile: string, runArgs: string[]): ServiceAdapter {
  return makeServiceAdapter({
    platformName: 'systemd (Linux user)',
    definitionPath: systemdUnitPath(profile),
    definitionExists: () => systemd.unitExists(profile),
    isRunning: () => systemd.isActive(profile),
    install: async () => {
      await systemd.writeUnit(profile, runArgs);
      return systemd.daemonReload();
    },
    start: () => systemd.enableAndStart(profile),
    stop: () => systemd.stop(profile),
    stopAndDisableAutostart: () => systemd.disableAndStop(profile),
    disableAutostart: () => systemd.disable(profile),
    restart: () => systemd.restart(profile),
    waitUntilStopped: (timeoutMs) => systemd.waitUntilInactive(profile, timeoutMs),
    remove: async () => {
      await systemd.deleteUnit(profile);
      return systemd.daemonReload();
    },
    status: () => {
      const text = systemd.describeService(profile);
      return {
        pid: text.match(/Main PID:\s*(\d+)/)?.[1],
        lastExitCode: text.match(/Process:\s+\d+\s+ExecStart=.*status=(\d+)/)?.[1],
      };
    },
  });
}

export function getServiceAdapter(
  profile = defaultAppPaths.profile,
  runArgs: string[] = ['run'],
): ServiceAdapter | null {
  if (process.platform === 'darwin') return makeLaunchdAdapter(profile, runArgs);
  if (process.platform === 'linux') return makeSystemdAdapter(profile, runArgs);
  return null;
}
