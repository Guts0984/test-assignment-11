import { LIMITS } from '@courier/shared';
import { parseMoneyToKop } from '@/shared/lib';

export type DeliverForm = { code: string; amount: string };

export function validateDeliver(
  f: DeliverForm,
  hasPhoto: boolean,
):
  | { ok: true; code: string; kop: number }
  | {
      ok: false;
      errors: Partial<Record<'code' | 'amount' | 'photo', 'required' | 'code' | 'invalid'>>;
    } {
  const errors: Partial<Record<'code' | 'amount' | 'photo', 'required' | 'code' | 'invalid'>> = {};
  const code = f.code.trim();
  if (code === '') errors.code = 'required';
  else if (!/^\d{6}$/.test(code)) errors.code = 'code';
  const kop = f.amount.trim() === '' ? 0 : parseMoneyToKop(f.amount);
  // the server refuses amounts above 100 000 ₴; catching it here keeps one bad value from rejecting a whole offline batch
  if (kop === null || kop > LIMITS.maxCodKop) errors.amount = 'invalid';
  if (!hasPhoto) errors.photo = 'required';
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, code, kop: kop! };
}
