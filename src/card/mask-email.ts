/**
 * Feishu's tenant message audit rejects any outbound message that contains a
 * raw email address with a 400 ("The messages do NOT pass the audit ...
 * contain sensitive data: EMAIL_ADDRESS"). A rejected CardKit update can leave
 * the visible Reply behind the Run. The usual trigger is a commit co-author
 * trailer (`Co-Authored-By: … <name@example.com>`) that the agent echoes in its
 * answer.
 *
 * We neutralize emails at the unified Reply render boundary by rewriting the
 * `@` to `[at]`. We do not use a lookalike `＠` or zero-width space because
 * Chinese text audits normalize fullwidth characters and strip zero-width
 * characters, either of which would re-form the address and trigger the block.
 * `[at]` remains readable and cannot normalize back into a valid address.
 */

// `local@domain.tld`, requiring a dotted domain ending in a 2+ letter TLD. The
// dotted-TLD requirement keeps us off npm scopes (`@larksuite/x` — no local
// part before `@`), version specs (`pkg@1.2.3` — numeric tail), and bare
// handles (`user@localhost` — no dot). SSH remotes (`git@host.tld`) DO match
// and get masked — intentional: the audit flags them as EMAIL_ADDRESS too, so
// masking is what lets the message through at all.
// Matching only the final local-part character avoids quadratic backtracking
// on long card text; the replacement changes only the following `@`.
const EMAIL_RE = /([A-Za-z0-9._%+-])@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;

/** Rewrite every email in `text` so the tenant audit won't flag it. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL_RE, '$1[at]$2');
}

/**
 * Recursively mask emails in every string value of a rendered card object.
 * Emails only occur in user/agent-authored content (text blocks, tool
 * input/output, reasoning, error notices); structural card values (tags,
 * colors, icon/callback tokens) never contain an `@`, so a blanket walk is
 * safe and guarantees no email slips through any field.
 */
export function deepMaskEmails<T>(value: T): T {
  if (typeof value === 'string') return maskEmails(value) as T;
  if (Array.isArray(value)) return value.map((v) => deepMaskEmails(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = deepMaskEmails(val);
    return out as T;
  }
  return value;
}
