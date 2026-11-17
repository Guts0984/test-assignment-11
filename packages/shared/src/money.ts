import { LIMITS, type Zone } from './constants';

/** All money values are integer kopecks. */
export type Kop = number;

export const BASE_FEE_KOP: Record<Zone, Kop> = { A: 6_000, B: 8_000, C: 11_000 };
export const EXTRA_KG_FEE_KOP = 800;
export const COD_COMMISSION_PERCENT = 2;
export const COD_COMMISSION_MIN_KOP = 2_000;

export type MoneyError = Error & { name: 'MoneyError' };

export function moneyError(message: string): MoneyError {
  const e = new Error(message) as MoneyError;
  e.name = 'MoneyError';
  return e;
}

export function isMoneyError(e: unknown): e is MoneyError {
  return e instanceof Error && e.name === 'MoneyError';
}

function assertKop(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw moneyError(`${name} must be a non-negative safe integer`);
  }
}

/** Number of started kilograms (weight in grams, 1 g counts as 1 kg). */
export function startedKilograms(weightG: number): number {
  return Math.ceil(weightG / 1000);
}

/** Delivery fee: zone base price + 8 UAH per started kilogram above the first. */
export function deliveryFeeKop(zone: Zone, weightG: number): Kop {
  if (!Number.isInteger(weightG) || weightG < LIMITS.minWeightG || weightG > LIMITS.maxWeightG) {
    throw moneyError(
      `weight must be an integer between ${LIMITS.minWeightG} and ${LIMITS.maxWeightG} g`,
    );
  }
  const extraKg = Math.max(0, startedKilograms(weightG) - 1);
  return BASE_FEE_KOP[zone] + extraKg * EXTRA_KG_FEE_KOP;
}

/**
 * Cash-on-delivery commission: 2% of the amount, minimum 20 UAH, rounded half up to a kopeck.
 * Integer arithmetic only: floor((cod * 2 + 50) / 100) == round_half_up(cod * 0.02).
 * Zero COD means no commission.
 */
export function codCommissionKop(codKop: Kop): Kop {
  assertKop(codKop, 'codKop');
  if (codKop > LIMITS.maxCodKop) throw moneyError('codKop exceeds the limit');
  if (codKop === 0) return 0;
  const pct = Math.floor((codKop * COD_COMMISSION_PERCENT + 50) / 100);
  return Math.max(COD_COMMISSION_MIN_KOP, pct);
}

export type Quote = {
  zone: Zone;
  weightG: number;
  codKop: Kop;
  feeKop: Kop;
  codCommissionKop: Kop;
  totalKop: Kop;
};

/** What the sender pays: fee + COD commission. The recipient separately pays `codKop`. */
export function quote(input: { zone: Zone; weightG: number; codKop: Kop }): Quote {
  const feeKop = deliveryFeeKop(input.zone, input.weightG);
  const commission = codCommissionKop(input.codKop);
  return {
    zone: input.zone,
    weightG: input.weightG,
    codKop: input.codKop,
    feeKop,
    codCommissionKop: commission,
    totalKop: feeKop + commission,
  };
}
