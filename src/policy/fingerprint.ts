import { createHash } from 'node:crypto';
import type { ProfileConfig } from '../config/profile-schema';
import { canonicalizeJcs } from '../session/jcs';

export interface FingerprintInputV2 {
  cwdRealpath: string;
  accessPolicyDigest: string;
  resourceScopeDigest: string;
}

export interface ResourceScopeDigestInput {
  source: 'im' | 'card' | 'comment' | 'meeting';
  chatId?: string;
  chatType?: 'p2p' | 'group';
  threadId?: string;
  commentScopeId?: string;
  resourceBindings?: string[];
}

export function policyFingerprint(input: FingerprintInputV2): string {
  return digestCanonical({
    version: 2,
    cwdRealpath: input.cwdRealpath,
    accessPolicyDigest: input.accessPolicyDigest,
    resourceScopeDigest: input.resourceScopeDigest,
  });
}

export function accessPolicyDigest(access: ProfileConfig['access']): string {
  return digestCanonical({
    admins: [...access.admins].sort(),
    allowedChats: [...access.allowedChats].sort(),
    allowedUsers: [...access.allowedUsers].sort(),
    requireMentionInGroup: access.requireMentionInGroup,
  });
}

export function resourceScopeDigest(input: ResourceScopeDigestInput): string {
  return digestCanonical({
    source: input.source,
    chatId: input.chatId ?? null,
    chatType: input.chatType ?? null,
    threadId: input.threadId ?? null,
    commentScopeId: input.commentScopeId ?? null,
    resourceBindings: [...(input.resourceBindings ?? [])].sort(),
  });
}

export function digestCanonical(value: unknown): string {
  return createHash('sha256')
    .update(canonicalizeJcs(value))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}
