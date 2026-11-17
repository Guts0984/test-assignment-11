import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import IntlMessageFormat from 'intl-messageformat';
import en from '@/shared/i18n/messages/en.json';
import uk from '@/shared/i18n/messages/uk.json';

type Tree = { [k: string]: string | Tree };
const flatten = (t: Tree, prefix = ''): Record<string, string> =>
  Object.fromEntries(
    Object.entries(t).flatMap(([k, v]) =>
      typeof v === 'string' ? [[`${prefix}${k}`, v]] : Object.entries(flatten(v, `${prefix}${k}.`)),
    ),
  );

const E = flatten(en as Tree);
const U = flatten(uk as Tree);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

describe('messages', () => {
  it('en and uk define exactly the same keys', () => {
    expect(Object.keys(U).sort()).toEqual(Object.keys(E).sort());
  });

  it('every message parses as ICU, and both locales use the same placeholders', () => {
    for (const key of Object.keys(E)) {
      const names = (s: string) => {
        const ast = new IntlMessageFormat(s, 'en').getAst();
        const found = new Set<string>();
        const walk = (nodes: unknown[]) => {
          for (const n of nodes as {
            type: number;
            value?: string;
            options?: Record<string, { value: unknown[] }>;
          }[]) {
            if (n.type !== 0 && n.value) found.add(n.value);
            if (n.options) for (const o of Object.values(n.options)) walk(o.value);
          }
        };
        walk(ast as unknown[]);
        return [...found].sort();
      };
      expect(() => new IntlMessageFormat(U[key]!, 'uk'), key).not.toThrow();
      expect(names(U[key]!), `placeholders of ${key}`).toEqual(names(E[key]!));
    }
  });

  it('every translation key used in the source exists (static keys)', () => {
    const missing: string[] = [];
    for (const file of sources(join(__dirname, '../src'))) {
      const code = readFileSync(file, 'utf8');
      const nsOf = (varName: string): string | undefined =>
        new RegExp(`const ${varName}\\s*=\\s*useTranslations\\('([^']+)'\\)`).exec(code)?.[1];
      for (const m of code.matchAll(/\b(t[a-z]*)\('([A-Za-z_.]+)'/g)) {
        const ns = nsOf(m[1]!);
        if (!ns) continue;
        const key = `${ns}.${m[2]}`;
        if (!(key in E)) missing.push(`${file.split('/src/')[1]}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every status, event, reason and error code has a label in both locales', async () => {
    const { DELIVERY_STATUSES, ERROR_CODES, FAIL_REASONS } = await import('@courier/shared');
    for (const s of DELIVERY_STATUSES) expect(E[`status.${s}`] && U[`status.${s}`], s).toBeTruthy();
    for (const c of Object.keys(ERROR_CODES))
      expect(E[`errors.${c}`] && U[`errors.${c}`], c).toBeTruthy();
    for (const r of FAIL_REASONS) expect(E[`reason.${r}`] && U[`reason.${r}`], r).toBeTruthy();
    for (const e of [
      'created',
      'assigned',
      'reassigned',
      'released',
      'cancelled',
      'picked_up',
      'delivered',
      'failed_attempt',
      'returning',
      'returned',
      'wrong_code',
      'handover_blocked',
      'handover_unblocked',
    ]) {
      expect(E[`event.${e}`] && U[`event.${e}`], e).toBeTruthy();
    }
  });

  it('Ukrainian plurals follow the CLDR rules (1, 2, 5, 11, 21, 22, 25 deliveries)', () => {
    const f = new IntlMessageFormat(U['list.total']!, 'uk');
    const out = (n: number) => String(f.format({ count: n }));
    expect([1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 25, 100, 101, 111, 112].map(out)).toEqual([
      '1 доставку знайдено',
      '2 доставки знайдено',
      '3 доставки знайдено',
      '4 доставки знайдено',
      '5 доставок знайдено',
      '11 доставок знайдено',
      '12 доставок знайдено',
      '14 доставок знайдено',
      '21 доставку знайдено',
      '22 доставки знайдено',
      '25 доставок знайдено',
      '100 доставок знайдено',
      '101 доставку знайдено',
      '111 доставок знайдено',
      '112 доставок знайдено',
    ]);
    const b = new IntlMessageFormat(U['board.waiting']!, 'uk');
    expect(String(b.format({ count: 3 }))).toBe('3 доставки чекають');
    expect(String(b.format({ count: 5 }))).toBe('5 доставок чекає');
    const spec = new IntlMessageFormat(U['errors.COURIER_LIMIT_REACHED']!, 'uk');
    expect(String(spec.format({ active: 8 }))).toBe("У кур'єра вже 8 доставок.");
    expect(String(spec.format({ active: 3 }))).toBe("У кур'єра вже 3 доставки.");
  });

  it('English plurals', () => {
    const f = new IntlMessageFormat(E['list.total']!, 'en');
    expect(String(f.format({ count: 1 }))).toBe('1 delivery found');
    expect(String(f.format({ count: 0 }))).toBe('0 deliveries found');
    expect(String(f.format({ count: 21 }))).toBe('21 deliveries found');
  });

  it('no Russian slipped in: no Russian-only letters in any message', () => {
    for (const [k, v] of Object.entries({ ...E, ...U })) expect(v, k).not.toMatch(/[ыэъё]/i);
  });
});
