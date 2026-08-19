import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI command registration', () => {
  it('registers the documented migrate command', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toMatch(/\.command\(['"]migrate['"]\)/);
    expect(source).toContain('runMigrate');
  });

  it('registers app-secret options for non-interactive app bootstrap commands', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    const appSecretOptions = source.match(/--app-secret <secret>/g) ?? [];
    expect(appSecretOptions.length).toBeGreaterThanOrEqual(3);
  });

  it('registers the lark-bot-bridge executable name', async () => {
    const [source, packageJson] = await Promise.all([
      readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8'),
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
    ]);
    const pkg = JSON.parse(packageJson) as {
      name: string;
      bin: Record<string, string>;
    };

    expect(source).toContain(".name('lark-bot-bridge')");
    expect(pkg.name).toBe('lark-bot-bridge');
    expect(pkg.bin).toEqual({
      'lark-bot-bridge': './bin/lark-bot-bridge.mjs',
    });
  });
});
