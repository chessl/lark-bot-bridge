import { describe, expect, it } from 'vitest';
import {
  normalizeAttachments,
  safeExtensionForMime,
  type AttachmentCandidate,
} from '../../../src/media/attachment.js';

describe('attachment policy normalization', () => {
  it('accepts allowed images and ordinary files with hash paths', () => {
    const out = normalizeAttachments([
      candidate({ kind: 'image', mime: 'image/png', hash: 'abc', absPath: '/media/abc.png' }),
      candidate({ kind: 'file', mime: 'application/zip', hash: 'def', absPath: '/media/def.zip' }),
    ]);

    expect(out).toMatchObject([
      {
        kind: 'image',
        absPath: '/media/abc.png',
        path: '/media/abc.png',
        mime: 'image/png',
        hash: 'abc',
        decision: 'accepted',
        requiredness: 'optional',
      },
      {
        kind: 'file',
        absPath: '/media/def.zip',
        decision: 'accepted',
      },
    ]);
  });

  it('rejects SVG and unknown images while skipping sticker/audio/video by default', () => {
    const out = normalizeAttachments([
      candidate({ kind: 'image', mime: 'image/svg+xml', hash: 'svg' }),
      candidate({ kind: 'image', mime: 'application/octet-stream', hash: 'unknown' }),
      candidate({ kind: 'sticker', mime: 'image/webp', hash: 'sticker' }),
      candidate({ kind: 'audio', mime: 'audio/ogg', hash: 'audio' }),
      candidate({ kind: 'video', mime: 'video/mp4', hash: 'video' }),
    ]);

    expect(out.map((item) => [item.kind, item.decision, item.rejectionReason])).toEqual([
      ['image', 'rejected', 'unsupported-image-mime'],
      ['image', 'rejected', 'unsupported-image-mime'],
      ['sticker', 'skipped', 'sticker'],
      ['audio', 'skipped', 'unsupported-kind'],
      ['video', 'skipped', 'unsupported-kind'],
    ]);
  });

  it('does not limit attachment count or size', () => {
    const candidates = Array.from({ length: 11 }, (_, index) =>
      candidate({
        kind: 'file',
        mime: 'application/vnd.rar',
        hash: String(index),
        size: 101 * 1024 * 1024,
      }),
    );
    candidates.push(
      candidate({
        kind: 'image',
        mime: 'image/png',
        hash: 'large-image',
        size: 101 * 1024 * 1024,
      }),
    );

    const out = normalizeAttachments(candidates);

    expect(out).toHaveLength(12);
    expect(out.every((item) => item.decision === 'accepted')).toBe(true);
  });

  it('uses MIME-derived safe extensions and never original names', () => {
    expect(safeExtensionForMime('image/jpeg')).toBe('jpg');
    expect(safeExtensionForMime('image/png')).toBe('png');
    expect(safeExtensionForMime('image/webp')).toBe('webp');
    expect(safeExtensionForMime('image/gif')).toBe('gif');
    expect(safeExtensionForMime('application/zip')).toBe('zip');
    expect(safeExtensionForMime('application/x-sh')).toBe('bin');
  });
});

function candidate(overrides: Partial<AttachmentCandidate> = {}): AttachmentCandidate {
  return {
    absPath: overrides.absPath ?? `/media/${overrides.hash ?? 'hash'}.png`,
    kind: overrides.kind ?? 'image',
    size: overrides.size ?? 100,
    mime: overrides.mime ?? 'image/png',
    hash: overrides.hash ?? 'hash',
    source: 'lark',
    sourceMessageId: 'om_1',
    sourceFileKey: 'file_key',
    originalName: overrides.originalName ?? 'secret original name.png',
  };
}
