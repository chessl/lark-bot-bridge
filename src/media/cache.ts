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
  constructor(attempts: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Attachment download failed after ${attempts} attempts: ${detail}`, { cause });
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
      lastError = error;
      await rm(destPath, { force: true });
      if (attempt + 1 === attempts) break;
      log.warn('media', 'download-retry', {
        attempt: attempt + 1,
        attempts,
        messageId: request.messageId,
        fileKey: request.resource.fileKey,
        err: error instanceof Error ? error.message : String(error),
      });
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, retryDelaysMs[attempt] ?? 0);
      await promise;
    }
  }
  throw new AttachmentDownloadError(attempts, lastError);
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
