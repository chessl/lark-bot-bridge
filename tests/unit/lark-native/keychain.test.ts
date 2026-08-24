import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock.spawn }));

import { OsKeychain } from '../../../src/lark-native/keychain';

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  input: string;
}

const keychainValues = new Map<string, string>();
const securityInputs: string[] = [];

function fakeSecurityChild(args: string[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.input = '';
  child.stdin.on('data', (chunk: Buffer) => (child.input += chunk.toString()));
  child.stdin.once('finish', () => {
    let code = 0;
    if (args[0] === '-i') {
      securityInputs.push(child.input);
      for (const line of child.input.trim().split('\n')) {
        const match = / -a (\S+) -w (\S+)$/.exec(line);
        if (!match?.[1] || !match[2]) throw new Error(`unexpected security command: ${line}`);
        keychainValues.set(match[1], match[2]);
      }
    } else {
      const account = args[args.indexOf('-a') + 1] ?? '';
      if (args[0] === 'find-generic-password') {
        const value = keychainValues.get(account);
        if (value) child.stdout.write(`${value}\n`);
        else code = 44;
      } else if (args[0] === 'delete-generic-password') {
        code = keychainValues.delete(account) ? 0 : 44;
      }
    }
    child.stdout.end();
    child.emit('exit', code);
  });
  return child;
}

beforeEach(() => {
  keychainValues.clear();
  securityInputs.length = 0;
  spawnMock.spawn.mockReset();
  spawnMock.spawn.mockImplementation((_command: string, args: string[]) => fakeSecurityChild(args));
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
});

afterEach(() => vi.restoreAllMocks());

describe('macOS user OAuth keychain', () => {
  it('stores large tokens in stdin-fed chunks and reads them back', async () => {
    const account = 'cli_app:ou_user';
    const value = JSON.stringify({
      accessToken: `access-${'x'.repeat(5_000)}`,
      refreshToken: `refresh-${'y'.repeat(5_000)}`,
    });
    const store = new OsKeychain();

    await store.set(account, value);
    expect(securityInputs).toHaveLength(1);
    expect(securityInputs[0]?.split('\n').length).toBeGreaterThan(3);
    expect(JSON.stringify(spawnMock.spawn.mock.calls)).not.toContain('access-');
    await expect(store.get(account)).resolves.toBe(value);

    await store.remove(account);
    await expect(store.get(account)).resolves.toBeUndefined();
  });
});
