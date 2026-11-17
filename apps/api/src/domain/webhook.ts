import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Signature scheme (documented in the README):
 *   Webhook-Id         stable notification id (the same on every retry and manual resend)
 *   Webhook-Timestamp  unix seconds when this attempt was made
 *   Webhook-Signature  "v1=" + hex(HMAC-SHA256(secret, `${id}.${timestamp}.${rawBody}`))
 */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('hex')}`;
}

export function webhookHeaders(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'courier-delivery-webhooks/1',
    'Webhook-Id': id,
    'Webhook-Timestamp': String(timestamp),
    'Webhook-Signature': signWebhook(secret, id, timestamp, body),
  };
}

/** True for loopback, private, link-local (cloud metadata!), CGNAT, multicast and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
    return (
      x.startsWith('fc') ||
      x.startsWith('fd') ||
      x.startsWith('fe8') ||
      x.startsWith('fe9') ||
      x.startsWith('fea') ||
      x.startsWith('feb') ||
      x.startsWith('ff')
    );
  }
  return true; // not an IP at all: treat as unsafe
}

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Static part of the SSRF guard: scheme, credentials, literal IPs. Hostnames still have to be resolved and every
 * resolved address checked (see `resolveAndCheck`). `allowedHosts` are trusted names (the compose stub).
 */
export function checkWebhookUrl(raw: string, allowedHosts: readonly string[]): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: 'only http(s) is allowed' };
  if (url.username || url.password)
    return { ok: false, reason: 'credentials in the URL are not allowed' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowedHosts.includes(host)) return { ok: true, url };
  if (isIP(host) && isPrivateAddress(host))
    return { ok: false, reason: 'private and loopback addresses are not allowed' };
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    return { ok: false, reason: 'internal host names are not allowed' };
  }
  return { ok: true, url };
}

export const parseAllowedHosts = (csv: string): string[] =>
  csv
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
