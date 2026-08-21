import { createHash } from 'node:crypto';

export function commentTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function commentDocumentScopeId(fileToken: string): string {
  return `comment-doc:${commentTokenDigest(fileToken)}`;
}

export function commentScopeId(fileToken: string, commentId: string): string {
  return `comment:${commentTokenDigest(`${fileToken}:${commentId}`)}`;
}
