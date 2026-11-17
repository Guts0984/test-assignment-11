const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a complete, real calendar date `YYYY-MM-DD` with a year in 1970..2100 (so a half-typed `0002-10-01` is rejected). */
export function isCompleteDate(value: string): boolean {
  const m = DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1970 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Whole days between two valid `YYYY-MM-DD` dates, inclusive of both ends. */
export function inclusiveDays(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}
