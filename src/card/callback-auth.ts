import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CallbackNonceStore } from './callback-store';

export interface CallbackAuthOptions {
  secret: string;
  nonceStore: CallbackNonceStore;
  now?: () => number;
  createNonce?: () => string;
}

export interface CallbackSignInput {
  runId: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  action: string;
  policyFingerprint: string;
  ttlMs: number;
}

export interface CallbackVerifyExpected {
  runId: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  action: string;
  policyFingerprint: string;
}

export interface CallbackPayload {
  r: string;
  s: string;
  c: string;
  o: string;
  a: string;
  exp: number;
  fp: string;
  n: string;
}

export type CallbackVerifyResult =
  | { ok: true; payload: CallbackPayload }
  | {
      ok: false;
      reason: 'malformed' | 'bad-signature' | 'expired' | 'context-mismatch' | 'nonce-replay';
    };

const PREFIX = 'bridge_cb.v1';

export class CallbackAuth {
  private readonly secret: string;
  private readonly nonceStore: CallbackNonceStore;
  private readonly now: () => number;
  private readonly createNonce: () => string;

  constructor(options: CallbackAuthOptions) {
    this.secret = options.secret;
    this.nonceStore = options.nonceStore;
    this.now = options.now ?? Date.now;
    this.createNonce = options.createNonce ?? (() => randomBytes(16).toString('base64url'));
  }

  sign(input: CallbackSignInput): string {
    const payload: CallbackPayload = {
      r: input.runId,
      s: input.scope,
      c: input.chatId,
      o: input.operatorOpenId,
      a: input.action,
      exp: this.now() + input.ttlMs,
      fp: input.policyFingerprint,
      n: this.createNonce(),
    };
    const encoded = encodeJson(payload);
    return `${PREFIX}.${encoded}.${sign(encoded, this.secret)}`;
  }

  verify(token: string, expected: CallbackVerifyExpected): CallbackVerifyResult {
    const parts = token.split('.');
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== PREFIX) {
      return { ok: false, reason: 'malformed' };
    }
    const encodedPayload = parts[2];
    const signature = parts[3];
    if (!encodedPayload || !signature) return { ok: false, reason: 'malformed' };

    const payload = decodePayload(encodedPayload);
    if (!payload) return { ok: false, reason: 'malformed' };
    if (!signatureMatches(signature, sign(encodedPayload, this.secret))) {
      return { ok: false, reason: 'bad-signature' };
    }
    if (payload.exp <= this.now()) return { ok: false, reason: 'expired' };
    if (!matchesExpected(payload, expected)) {
      return { ok: false, reason: 'context-mismatch' };
    }

    if (!this.nonceStore.consume(payload.n)) {
      return { ok: false, reason: 'nonce-replay' };
    }
    return { ok: true, payload };
  }
}

function matchesExpected(payload: CallbackPayload, expected: CallbackVerifyExpected): boolean {
  return (
    payload.r === expected.runId &&
    payload.s === expected.scope &&
    payload.c === expected.chatId &&
    payload.o === expected.operatorOpenId &&
    payload.a === expected.action &&
    payload.fp === expected.policyFingerprint
  );
}

function encodeJson(payload: CallbackPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(encoded: string): CallbackPayload | undefined {
  try {
    const raw = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<CallbackPayload>;
    if (
      typeof raw.r !== 'string' ||
      typeof raw.s !== 'string' ||
      typeof raw.c !== 'string' ||
      typeof raw.o !== 'string' ||
      typeof raw.a !== 'string' ||
      typeof raw.exp !== 'number' ||
      typeof raw.fp !== 'string' ||
      typeof raw.n !== 'string'
    ) {
      return undefined;
    }
    return {
      r: raw.r,
      s: raw.s,
      c: raw.c,
      o: raw.o,
      a: raw.a,
      exp: raw.exp,
      fp: raw.fp,
      n: raw.n,
    };
  } catch {
    return undefined;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signatureMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
