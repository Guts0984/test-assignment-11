import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 6-digit handover code, uniformly random (crypto.randomInt, not Math.random). */
export const generateCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** 128 bits, URL safe, 22 chars. */
export const generateToken = (): string => randomBytes(16).toString('base64url');

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Constant-time comparison of two equal-purpose strings (different lengths never match). */
export function safeEqual(a: string, b: string): boolean {
  const ab = createHash('sha256').update(a).digest();
  const bb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ab, bb) && a.length === b.length;
}

export const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');
