import type { AppPaths } from '../../src/config/app-paths';
import {
  type AcquiredRuntimeLock,
  acquireAppRuntimeLock,
  acquireProfileRuntimeLock,
} from '../../src/runtime/locks';

export async function withRuntimeLocks<T>(
  paths: Pick<AppPaths, 'profile' | 'profileLockFile' | 'appLockFile'>,
  appId: string,
  fn: (locks: AcquiredRuntimeLock[]) => Promise<T> | T,
): Promise<T> {
  const locks: AcquiredRuntimeLock[] = [];
  try {
    locks.push(await acquireProfileRuntimeLock(paths));
    locks.push(await acquireAppRuntimeLock(paths, appId));
    return await fn(locks);
  } finally {
    await Promise.allSettled(locks.reverse().map((lock) => lock.release()));
  }
}
