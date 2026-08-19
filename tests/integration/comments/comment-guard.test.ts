import type { CommentEvent } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import { handleCommentMention } from '../../../src/bot/comments.js';

describe('comment guard', () => {
  it('skips unmentioned, unsupported, and self-authored comments before remote access', async () => {
    const channel = { botIdentity: { openId: 'ou-bot' } };

    for (const evt of [
      event({ mentionedBot: false }),
      event({ fileType: 'bitable' }),
      event({ operator: { openId: 'ou-bot' } }),
    ]) {
      await expect(handleCommentMention({ channel, evt } as never)).resolves.toBeUndefined();
    }
  });
});

function event(overrides: Partial<CommentEvent>): CommentEvent {
  return {
    fileToken: 'doc-token',
    fileType: 'docx',
    commentId: 'comment-1',
    replyId: 'reply-1',
    mentionedBot: true,
    operator: { openId: 'ou-user' },
    ...overrides,
  } as CommentEvent;
}
