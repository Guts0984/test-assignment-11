import { LIMITS } from './constants';

/**
 * Pause before retry number `attempt` (1-based: the pause after the 1st failed delivery try).
 * Doubles each time, capped at 24 hours. `jitter` is in [-1, 1] and scales a +-20 % spread.
 */
export function backoffSeconds(
  attempt: number,
  opts: { base?: number; max?: number; jitter?: number } = {},
): number {
  const base = opts.base ?? LIMITS.webhookBackoffBaseSeconds;
  const max = opts.max ?? LIMITS.webhookBackoffMaxSeconds;
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  // Cap the exponent: 2 ** 1024 is Infinity, which must not leak out.
  const raw = Math.min(max, base * 2 ** Math.min(n - 1, 40));
  const j = Number.isFinite(opts.jitter ?? 0) ? Math.max(-1, Math.min(1, opts.jitter ?? 0)) : 0;
  return Math.min(max, Math.max(1, Math.round(raw * (1 + 0.2 * j))));
}
