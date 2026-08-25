import type { AgentAttachment as PolicyAttachment } from '../policy/run-policy';
import type { BridgePromptAttachment } from '../agent/prompt';

export type AttachmentKind = 'image' | 'file' | 'audio' | 'video' | 'sticker';
export type AttachmentDecision = 'accepted' | 'rejected' | 'skipped';

export interface AttachmentCandidate {
  absPath: string;
  kind: AttachmentKind;
  size: number;
  mime: string;
  hash: string;
  source: 'lark';
  sourceMessageId: string;
  sourceFileKey: string;
  originalName?: string;
}

export interface NormalizedAttachment extends AttachmentCandidate {
  path: string;
  requiredness: 'required' | 'optional';
  decision: AttachmentDecision;
  rejectionReason?: string;
}

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MIME_EXT: Record<string, string> = {
  ...IMAGE_MIME_EXT,
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
};

export function normalizeAttachments(
  candidates: readonly AttachmentCandidate[],
): NormalizedAttachment[] {
  return candidates.map((candidate) => {
    const base = {
      ...candidate,
      path: candidate.absPath,
      requiredness: 'optional' as const,
    };
    const early = earlyDecision(candidate);
    return early ? { ...base, ...early } : { ...base, decision: 'accepted' as const };
  });
}

export function safeExtensionForMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? 'bin';
}

export function toPolicyAttachment(attachment: NormalizedAttachment): PolicyAttachment {
  return {
    kind: attachment.kind,
    path: attachment.absPath,
    hash: attachment.hash,
    size: attachment.size,
    originalName: attachment.originalName,
    requiredness: attachment.requiredness,
    decision: attachment.decision,
    ...(attachment.rejectionReason ? { rejectionReason: attachment.rejectionReason } : {}),
  };
}

export function toPromptAttachment(attachment: NormalizedAttachment): BridgePromptAttachment {
  return {
    path: attachment.absPath,
    kind: attachment.kind,
    hash: attachment.hash,
    size: attachment.size,
    mime: attachment.mime,
    sourceMessageId: attachment.sourceMessageId,
    requiredness: attachment.requiredness,
    decision: attachment.decision,
    ...(attachment.rejectionReason ? { rejectionReason: attachment.rejectionReason } : {}),
  };
}

function earlyDecision(
  candidate: AttachmentCandidate,
): Pick<NormalizedAttachment, 'decision' | 'rejectionReason'> | undefined {
  if (candidate.kind === 'sticker') {
    return { decision: 'skipped', rejectionReason: 'sticker' };
  }
  if (candidate.kind === 'audio' || candidate.kind === 'video') {
    return { decision: 'skipped', rejectionReason: 'unsupported-kind' };
  }
  if (candidate.kind === 'image' && !IMAGE_MIME_EXT[candidate.mime.toLowerCase()]) {
    return { decision: 'rejected', rejectionReason: 'unsupported-image-mime' };
  }
  return undefined;
}
