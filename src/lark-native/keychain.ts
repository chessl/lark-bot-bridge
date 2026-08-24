import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const SERVICE = 'lark-bot-bridge';
const TIMEOUT_MS = 15_000;

const DARWIN_CHUNK_PREFIX = 'lark-bot-bridge-chunks:';
const DARWIN_CHUNK_SIZE = 3_000;

export interface CredentialStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  remove(account: string): Promise<void>;
}

export class OsKeychain implements CredentialStore {
  async get(account: string): Promise<string | undefined> {
    if (process.platform === 'darwin') return getDarwinCredential(account);
    const result = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    if (result.code === 0) return result.stdout.trim() || undefined;
    if (result.code === 1 && !result.stderr.trim()) return undefined;
    throw keychainError('read', result.stderr);
  }

  async set(account: string, value: string): Promise<void> {
    if (process.platform === 'darwin') return setDarwinCredential(account, value);
    const result = await run(
      'secret-tool',
      ['store', '--label', 'lark-bot-bridge user OAuth', 'service', SERVICE, 'account', account],
      value,
    );
    if (result.code !== 0) throw keychainError('write', result.stderr);
  }

  async remove(account: string): Promise<void> {
    if (process.platform === 'darwin') return removeDarwinCredential(account);
    const result = await run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
    if (result.code === 0 || (result.code === 1 && !result.stderr.trim())) return;
    throw keychainError('delete', result.stderr);
  }
}

interface DarwinManifest {
  generation: string;
  chunks: number;
}

async function getDarwinCredential(account: string): Promise<string | undefined> {
  const key = darwinAccount(account);
  const value = await readDarwinPassword(key);
  if (!value) return undefined;
  const manifest = parseDarwinManifest(value);
  if (!manifest) return value;
  const chunks: string[] = [];
  for (let index = 0; index < manifest.chunks; index++) {
    const chunk = await readDarwinPassword(darwinChunkAccount(key, manifest.generation, index));
    if (!chunk) throw new Error('OS keychain read failed: credential is incomplete');
    chunks.push(chunk);
  }
  return Buffer.from(chunks.join(''), 'base64').toString();
}

async function setDarwinCredential(account: string, value: string): Promise<void> {
  const key = darwinAccount(account);
  const previous = parseDarwinManifest(await readDarwinPassword(key));
  const generation = randomUUID().replaceAll('-', '');
  const encoded = Buffer.from(value).toString('base64');
  const chunks = encoded.match(new RegExp(`.{1,${DARWIN_CHUNK_SIZE}}`, 'g')) ?? [''];
  const commands = chunks.map(
    (chunk, index) =>
      `add-generic-password -U -s ${SERVICE} -a ${darwinChunkAccount(key, generation, index)} -w ${chunk}`,
  );
  commands.push(
    `add-generic-password -U -s ${SERVICE} -a ${key} -w ${encodeDarwinManifest({
      generation,
      chunks: chunks.length,
    })}`,
  );
  const result = await run('security', ['-i'], `${commands.join('\n')}\n`);
  if (result.code !== 0) throw keychainError('write', result.stderr);
  if (previous) await removeDarwinGeneration(key, previous).catch(() => undefined);
}

async function removeDarwinCredential(account: string): Promise<void> {
  const key = darwinAccount(account);
  const manifest = parseDarwinManifest(await readDarwinPassword(key));
  if (manifest) await removeDarwinGeneration(key, manifest);
  const result = await run('security', ['delete-generic-password', '-s', SERVICE, '-a', key]);
  if (result.code === 0 || result.code === 44) return;
  throw keychainError('delete', result.stderr);
}

async function removeDarwinGeneration(key: string, manifest: DarwinManifest): Promise<void> {
  for (let index = 0; index < manifest.chunks; index++) {
    const result = await run('security', [
      'delete-generic-password',
      '-s',
      SERVICE,
      '-a',
      darwinChunkAccount(key, manifest.generation, index),
    ]);
    if (result.code !== 0 && result.code !== 44) throw keychainError('delete', result.stderr);
  }
}

async function readDarwinPassword(account: string): Promise<string | undefined> {
  const result = await run('security', [
    'find-generic-password',
    '-s',
    SERVICE,
    '-a',
    account,
    '-w',
  ]);
  if (result.code === 0) return result.stdout.trim() || undefined;
  if (result.code === 44) return undefined;
  throw keychainError('read', result.stderr);
}

function darwinAccount(account: string): string {
  return Buffer.from(account).toString('base64url');
}

function darwinChunkAccount(account: string, generation: string, index: number): string {
  return `${account}.${generation}.${index}`;
}

function encodeDarwinManifest(manifest: DarwinManifest): string {
  return `${DARWIN_CHUNK_PREFIX}${Buffer.from(JSON.stringify(manifest)).toString('base64url')}`;
}

function parseDarwinManifest(value: string | undefined): DarwinManifest | undefined {
  if (!value?.startsWith(DARWIN_CHUNK_PREFIX)) return undefined;
  try {
    const manifest = JSON.parse(
      Buffer.from(value.slice(DARWIN_CHUNK_PREFIX.length), 'base64url').toString(),
    ) as Partial<DarwinManifest>;
    return typeof manifest.generation === 'string' &&
      Number.isInteger(manifest.chunks) &&
      (manifest.chunks ?? 0) > 0
      ? (manifest as DarwinManifest)
      : undefined;
  } catch {
    return undefined;
  }
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], stdin?: string): Promise<ProcessResult> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return Promise.reject(new Error(`OS keychain is unsupported on ${process.platform}`));
  }
  const { promise, resolve, reject } = Promise.withResolvers<ProcessResult>();
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  child.once('error', (error) => {
    clearTimeout(timer);
    reject(
      new Error(
        process.platform === 'linux' && (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Linux Secret Service unavailable: install secret-tool/libsecret and unlock a keyring'
          : `OS keychain unavailable: ${error.message}`,
      ),
    );
  });
  child.once('exit', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
  child.stdin?.end(stdin);
  return promise;
}

function keychainError(operation: string, stderr: string): Error {
  const detail = stderr.trim().split('\n')[0] || 'credential manager unavailable';
  return new Error(`OS keychain ${operation} failed: ${detail}`);
}
