import { createDeliverySchema, LIMITS } from '@courier/shared';
import { parseMoneyToKop } from '@/shared/lib';

export type FormValues = {
  recipientName: string;
  recipientPhone: string;
  city: string;
  street: string;
  house: string;
  apartment: string;
  note: string;
  zone: 'A' | 'B' | 'C';
  weightKg: string;
  cod: string;
};

export const EMPTY_FORM: FormValues = {
  recipientName: '',
  recipientPhone: '',
  city: '',
  street: '',
  house: '',
  apartment: '',
  note: '',
  zone: 'A',
  weightKg: '',
  cod: '',
};

/** "1,5" kg → 1500 g (null when it is not a number with at most 3 decimals). */
export function parseWeightToGrams(input: string): number | null {
  const t = input.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const g = Math.round(Number(t) * 1000);
  return Number.isSafeInteger(g) ? g : null;
}

export type FieldKey = keyof FormValues;
/** Visual order of the fields: the first problem in this order is the one that gets the focus. */
export const FIELD_ORDER: FieldKey[] = [
  'recipientName',
  'recipientPhone',
  'city',
  'street',
  'house',
  'apartment',
  'note',
  'zone',
  'weightKg',
  'cod',
];
export type FieldIssue = {
  field: FieldKey;
  kind: 'required' | 'invalid' | 'weightRange' | 'codRange' | 'tooLong';
};

/** Form values → API body, or the list of problems (one per field) when something is wrong. */
export function toRequest(
  v: FormValues,
):
  | { ok: true; body: ReturnType<typeof createDeliverySchema.parse> }
  | { ok: false; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  const grams = parseWeightToGrams(v.weightKg);
  const cod = v.cod.trim() === '' ? 0 : parseMoneyToKop(v.cod);
  if (v.weightKg.trim() === '') issues.push({ field: 'weightKg', kind: 'required' });
  else if (grams === null) issues.push({ field: 'weightKg', kind: 'invalid' });
  else if (grams < LIMITS.minWeightG || grams > LIMITS.maxWeightG)
    issues.push({ field: 'weightKg', kind: 'weightRange' });
  if (cod === null) issues.push({ field: 'cod', kind: 'invalid' });
  else if (cod > LIMITS.maxCodKop) issues.push({ field: 'cod', kind: 'codRange' });

  const parsed = createDeliverySchema.safeParse({
    recipientName: v.recipientName,
    recipientPhone: v.recipientPhone,
    address: {
      city: v.city,
      street: v.street,
      house: v.house,
      ...(v.apartment.trim() ? { apartment: v.apartment } : {}),
      ...(v.note.trim() ? { note: v.note } : {}),
    },
    zone: v.zone,
    weightG: grams ?? 0,
    codKop: cod ?? 0,
  });
  if (!parsed.success) {
    const map: Record<string, FieldKey> = {
      recipientName: 'recipientName',
      recipientPhone: 'recipientPhone',
      'address.city': 'city',
      'address.street': 'street',
      'address.house': 'house',
      'address.apartment': 'apartment',
      'address.note': 'note',
      zone: 'zone',
    };
    for (const i of parsed.error.issues) {
      const field = map[i.path.join('.')];
      if (!field || issues.some((x) => x.field === field)) continue;
      const empty = (v[field] as string).trim() === '';
      issues.push({
        field,
        kind: empty ? 'required' : i.code === 'too_big' ? 'tooLong' : 'invalid',
      });
    }
  }
  if (issues.length > 0 || !parsed.success) return { ok: false, issues };
  return { ok: true, body: parsed.data };
}

/** Maps an API field path ("address.city", "weightG") back to a form field. */
export const SERVER_FIELD: Record<string, FieldKey> = {
  recipientName: 'recipientName',
  recipientPhone: 'recipientPhone',
  'address.city': 'city',
  'address.street': 'street',
  'address.house': 'house',
  'address.apartment': 'apartment',
  'address.note': 'note',
  zone: 'zone',
  weightG: 'weightKg',
  codKop: 'cod',
};
