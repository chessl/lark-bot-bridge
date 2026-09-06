import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

export class CallbackNonceStore {
  private readonly path: string;
  private readonly nonces = new Set<string>();
  private saving: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return;
      this.nonces.clear();
      for (const [nonce, state] of Object.entries(raw as Record<string, unknown>)) {
        if (state === 'used' || state === 'revoked') this.nonces.add(nonce);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.fail('callback-nonce', err, { step: 'load' });
    }
  }

  consume(nonce: string): boolean {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(
          this.path,
          `${JSON.stringify(Object.fromEntries([...this.nonces].map((nonce) => [nonce, 'used'])), null, 2)}\n`,
          { mode: 0o600 },
        );
      })
      .catch((err: unknown) => {
        log.fail('callback-nonce', err, { step: 'persist' });
      });
  }
}
