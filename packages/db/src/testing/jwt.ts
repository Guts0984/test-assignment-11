import { createHmac } from 'node:crypto';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** Signs an HS256 JWT. Used to build FORGED tokens in attack tests (wrong secret, alg none, ...). */
export function signJwt(
  claims: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const head = b64(header);
  const body = b64(claims);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** A token with alg "none" and no signature. */
export function unsignedJwt(claims: Record<string, unknown>): string {
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
}
