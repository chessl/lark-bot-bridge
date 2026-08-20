import { readFile } from 'node:fs/promises';
import { defaultAppPaths } from '../config/app-paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

export interface SessionEntry {
  updatedAt: number;
  /** Per-scope idle-timeout override (minutes). 0 = explicitly off. */
  idleTimeoutMinutes: number;
}

type SessionMap = Record<string, SessionEntry>;

export class SessionStore {
  private data: SessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = defaultAppPaths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, Partial<SessionEntry>>;
      this.data = {};
      for (const [scopeId, entry] of Object.entries(raw)) {
        if (
          !entry ||
          typeof entry.updatedAt !== 'number' ||
          typeof entry.idleTimeoutMinutes !== 'number'
        ) {
          continue;
        }
        this.data[scopeId] = {
          updatedAt: entry.updatedAt,
          idleTimeoutMinutes: entry.idleTimeoutMinutes,
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  getIdleTimeoutMinutes(scopeId: string): number | undefined {
    return this.data[scopeId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(scopeId: string, minutes: number): void {
    this.data[scopeId] = {
      idleTimeoutMinutes: Math.min(Math.max(Math.floor(minutes), 0), 120),
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(scopeId: string): boolean {
    if (!this.data[scopeId]) return false;
    delete this.data[scopeId];
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('session', err, { step: 'persist' });
      });
  }
}
