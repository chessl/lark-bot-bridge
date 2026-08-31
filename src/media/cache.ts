import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel, ResourceDescriptor } from '@larksuite/channel';
import { defaultAppPaths } from '../config/app-paths';
import { log } from '../core/logger';
import {
  type AttachmentCandidate,
  type AttachmentKind,
  type NormalizedAttachment,
  normalizeAttachments,
  safeExtensionForMime,
} from './attachment';

export type LocalAttachment = NormalizedAttachment;

export interface MediaResolveOptions {
  cacheMaxBytes?: number;
}

export interface ResourceRequest {
  messageId: string;
  resource: ResourceDescriptor;
}

const DOWNLOAD_RETRY_DELAYS_MS = [250, 1_000] as const;

export class AttachmentDownloadError extends Error {
  constructor(
    attempts: number,
    cause: unknown,
    public readonly reason?: AttachmentDownloadFailureReason,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Attachment download failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${detail}`,
      {
        cause,
      },
    );
    this.name = 'AttachmentDownloadError';
  }
}

export async function downloadLarkResourceToFile(
  channel: LarkChannel,
  request: ResourceRequest,
  destPath: string,
  retryDelaysMs: readonly number[] = DOWNLOAD_RETRY_DELAYS_MS,
): Promise<{ contentType?: string; bytesWritten: number }> {
  const attempts = retryDelaysMs.length + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await rm(destPath, { force: true });
    try {
      const result = await channel.downloadResourceToFile(
        request.messageId,
        request.resource.fileKey,
        request.resource.type === 'image' ? 'image' : 'file',
        destPath,
      );
      const downloaded = await stat(destPath);
      if (!downloaded.isFile() || downloaded.size === 0) {
        throw new Error('Downloaded attachment is empty');
      }
      if (downloaded.size !== result.bytesWritten) {
        throw new Error(
          `Downloaded attachment size mismatch: wrote ${result.bytesWritten}, found ${downloaded.size}`,
        );
      }
      return result;
    } catch (error) {
      const failure = await describeDownloadFailure(error);
      lastError = failure.error;
      const attemptCount = attempt + 1;
      await rm(destPath, { force: true });
      if (!failure.retryable || attemptCount === attempts) {
        throw new AttachmentDownloadError(attemptCount, failure.error, failure.reason);
      }
      log.warn('media', 'download-retry', {
        attempt: attemptCount,
        attempts,
        messageId: request.messageId,
        fileKey: request.resource.fileKey,
        err: failure.error.message,
      });
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, retryDelaysMs[attempt] ?? 0);
      await promise;
    }
  }
  throw new AttachmentDownloadError(attempts, lastError);
}

type AttachmentDownloadFailureReason = 'too-large';

interface DownloadFailure {
  error: Error;
  retryable: boolean;
  reason?: AttachmentDownloadFailureReason;
}

interface FeishuApiError {
  code?: number;
  msg?: string;
}

interface HttpErrorResponse {
  status: number | undefined;
  data: unknown;
}

async function describeDownloadFailure(error: unknown): Promise<DownloadFailure> {
  const response = errorResponse(error);
  const status = typeof response?.status === 'number' ? response.status : undefined;
  const apiError = await readFeishuApiError(response?.data);
  const reason: AttachmentDownloadFailureReason | undefined =
    apiError?.code === 234037 ? 'too-large' : undefined;
  return {
    error: formatDownloadError(error, apiError),
    retryable:
      status === undefined
        ? apiError === undefined
        : status === 408 || status === 429 || status >= 500,
    ...(reason ? { reason } : {}),
  };
}

function formatDownloadError(error: unknown, apiError: FeishuApiError | undefined): Error {
  if (apiError?.code === 234037) {
    const detail = apiError.msg ? `: ${apiError.msg}` : '';
    return new Error(
      `Feishu cannot download message attachments larger than 100 MB (code 234037${detail}); compress or split the file, or send a Drive link`,
      { cause: error },
    );
  }
  if (apiError) {
    const code = apiError.code === undefined ? '' : `code ${apiError.code}`;
    const separator = code && apiError.msg ? ': ' : '';
    return new Error(`Feishu resource download failed (${code}${separator}${apiError.msg ?? ''})`, {
      cause: error,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function readFeishuApiError(data: unknown): Promise<FeishuApiError | undefined> {
  try {
    const payload = await responsePayload(data);
    if (typeof payload !== 'object' || payload === null) return undefined;
    const code = 'code' in payload && typeof payload.code === 'number' ? payload.code : undefined;
    const msg = 'msg' in payload && typeof payload.msg === 'string' ? payload.msg : undefined;
    return code === undefined && msg === undefined ? undefined : { code, msg };
  } catch {
    return undefined;
  }
}

async function responsePayload(data: unknown): Promise<unknown> {
  if (typeof data === 'string') return parseJson(data);
  if (data instanceof Uint8Array) return parseJson(Buffer.from(data).toString('utf8'));
  if (!isAsyncIterable(data)) return data;

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of data) {
    const buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : undefined;
    if (!buffer) continue;
    bytes += buffer.length;
    if (bytes > 64 * 1024) return undefined;
    chunks.push(buffer);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function errorResponse(error: unknown): HttpErrorResponse | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  const response = error.response;
  if (typeof response !== 'object' || response === null) return undefined;
  return {
    status:
      'status' in response && typeof response.status === 'number' ? response.status : undefined,
    data: 'data' in response ? response.data : undefined,
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

export class MediaCache {
  private readonly channel: LarkChannel;
  private readonly rootDir: string;

  constructor(channel: LarkChannel, rootDir: string = defaultAppPaths.mediaDir) {
    this.channel = channel;
    this.rootDir = rootDir;
  }

  async resolve(
    items: ResourceRequest[],
    options: MediaResolveOptions = {},
  ): Promise<LocalAttachment[]> {
    if (items.length === 0) return [];
    await mkdir(this.rootDir, { recursive: true });

    const candidates: AttachmentCandidate[] = [];
    for (const item of items) {
      candidates.push(await this.resolveOne(item));
    }
    const normalized = normalizeAttachments(candidates);
    if (typeof options.cacheMaxBytes === 'number') {
      await enforceCacheMaxBytes(
        this.rootDir,
        options.cacheMaxBytes,
        new Set(
          normalized
            .filter((attachment) => attachment.decision === 'accepted')
            .map((attachment) => attachment.absPath),
        ),
      );
    }
    return normalized;
  }

  private async resolveOne(item: ResourceRequest): Promise<AttachmentCandidate> {
    const { messageId, resource: r } = item;
    const kind: AttachmentKind = r.type;
    const tmpPath = join(this.rootDir, `.tmp-${process.pid}-${randomUUID()}`);

    // Feishu's received-message resource endpoint needs both owner IDs and maps
    // every non-image kind to `file`. Stream to a temporary file, validate the
    // complete byte count, then publish by content hash.
    try {
      const { contentType, bytesWritten } = await downloadLarkResourceToFile(
        this.channel,
        item,
        tmpPath,
      );
      const hash = await hashFile(tmpPath);
      const mime = contentType ?? defaultMime(kind);
      const ext = safeExtensionForMime(mime);
      const absPath = join(this.rootDir, `${hash}.${ext}`);
      try {
        await stat(absPath);
        log.info('media', 'cache-hit', { path: absPath });
      } catch {
        await rename(tmpPath, absPath);
      }
      const candidate: AttachmentCandidate = {
        absPath,
        kind,
        size: bytesWritten,
        mime,
        hash,
        source: 'lark',
        sourceMessageId: messageId,
        sourceFileKey: r.fileKey,
        ...(r.fileName ? { originalName: r.fileName } : {}),
      };
      log.info('media', 'downloaded', {
        path: candidate.absPath,
        size: candidate.size,
      });
      return candidate;
    } finally {
      await rm(tmpPath, { force: true });
    }
  }
}

function defaultMime(kind: AttachmentKind): string {
  switch (kind) {
    case 'image':
      return 'image/png';
    case 'audio':
      return 'audio/ogg';
    case 'video':
      return 'video/mp4';
    default:
      return 'application/octet-stream';
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function enforceCacheMaxBytes(
  root: string,
  maxBytes: number,
  protectedPaths: ReadonlySet<string>,
): Promise<void> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
  const files = await Promise.all(
    (await listFiles(root)).map(async (path) => {
      const fileStat = await stat(path);
      return { path, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
    }),
  );
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files
    .filter((item) => !protectedPaths.has(item.path))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    await rm(file.path, { force: true });
    total -= file.size;
  }
}
