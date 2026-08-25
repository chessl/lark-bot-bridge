import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AttachmentDownloadError,
  downloadLarkResourceToFile,
  MediaCache,
} from '../../../src/media/cache.js';

const cleanups: Array<() => Promise<void>> = [];

describe('hash media attachment resolver', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('downloads message resources into content-hash paths without original names or file keys', async () => {
    const root = await tempDir();
    const bytes = Buffer.from('image-bytes');
    const cache = new MediaCache(fakeChannel(bytes), root);

    const [attachment] = await cache.resolve([
      {
        messageId: 'om_1',
        resource: {
          type: 'image',
          fileKey: 'img_secret_key',
          fileName: 'private name.png',
        } as never,
      },
    ]);
    if (!attachment) throw new Error('attachment missing');

    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(attachment).toMatchObject({
      absPath: join(root, `${hash}.png`),
      path: join(root, `${hash}.png`),
      hash,
      mime: 'image/png',
      sourceMessageId: 'om_1',
      sourceFileKey: 'img_secret_key',
      originalName: 'private name.png',
      decision: 'accepted',
    });
    expect(attachment.absPath).not.toContain('img_secret_key');
    expect(attachment.absPath).not.toContain('private');
    expect(await readFile(attachment.absPath, 'utf8')).toBe('image-bytes');
  });

  it('enforces cacheMaxBytes without deleting files from the current resolution', async () => {
    const root = await tempDir();
    const oldPath = join(root, 'old.bin');
    await writeFile(oldPath, 'old-cache-entry');
    const oldTime = new Date(Date.now() - 10_000);
    await utimes(oldPath, oldTime, oldTime);

    const bytes = Buffer.from('fresh-image');
    const cache = new MediaCache(fakeChannel(bytes), root);
    const [attachment] = await cache.resolve(
      [
        {
          messageId: 'om_1',
          resource: { type: 'image', fileKey: 'img_secret_key' } as never,
        },
      ],
      { cacheMaxBytes: bytes.length },
    );
    if (!attachment) throw new Error('attachment missing');

    await expect(stat(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(attachment.absPath)).resolves.toMatchObject({ size: bytes.length });
  });

  it('keeps non-raster images as inspectable files', async () => {
    const root = await tempDir();
    const bytes = Buffer.from('unsupported-image');
    const cache = new MediaCache(fakeChannel(bytes, 'image/svg+xml'), root);

    const [attachment] = await cache.resolve([
      {
        messageId: 'om_1',
        resource: { type: 'image', fileKey: 'img_secret_key' } as never,
      },
    ]);
    if (!attachment) throw new Error('attachment missing');

    expect(attachment).toMatchObject({
      kind: 'file',
      decision: 'accepted',
      mime: 'image/svg+xml',
    });
    await expect(stat(attachment.absPath)).resolves.toMatchObject({ size: bytes.length });
  });

  it('retries partial downloads and only returns a complete validated file', async () => {
    const root = await tempDir();
    const path = join(root, 'resource.bin');
    const download = vi.fn(async (_m: string, _f: string, _t: string, dest: string) => {
      if (download.mock.calls.length < 3) {
        await writeFile(dest, '');
        return { bytesWritten: 0 };
      }
      await writeFile(dest, 'complete');
      return { contentType: 'application/octet-stream', bytesWritten: 8 };
    });

    await expect(
      downloadLarkResourceToFile(
        { downloadResourceToFile: download } as never,
        {
          messageId: 'om_retry',
          resource: { type: 'file', fileKey: 'file_retry' } as never,
        },
        path,
        [0, 0],
      ),
    ).resolves.toMatchObject({ bytesWritten: 8 });
    expect(download).toHaveBeenCalledTimes(3);
    expect(await readFile(path, 'utf8')).toBe('complete');
  });

  it('removes partial files when every download attempt fails', async () => {
    const root = await tempDir();
    const path = join(root, 'resource.bin');
    const download = vi.fn(async (_m: string, _f: string, _t: string, dest: string) => {
      await writeFile(dest, 'partial');
      throw new Error('connection reset');
    });

    await expect(
      downloadLarkResourceToFile(
        { downloadResourceToFile: download } as never,
        {
          messageId: 'om_failed',
          resource: { type: 'file', fileKey: 'file_failed' } as never,
        },
        path,
        [0, 0],
      ),
    ).rejects.toBeInstanceOf(AttachmentDownloadError);
    expect(download).toHaveBeenCalledTimes(3);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function fakeChannel(bytes: Buffer, contentType = 'image/png') {
  return {
    async downloadResourceToFile(
      _messageId: string,
      _fileKey: string,
      _type: string,
      destPath: string,
    ) {
      await writeFile(destPath, bytes);
      return { contentType, bytesWritten: bytes.length };
    },
  } as never;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'attachment-resolver-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
