/** Числовой query-параметр с дефолтом и границами.
    В отличие от `parseFloat(sp.get(k) || 'def') || def`, явно переданный 0
    не подменяется дефолтом, а корректно зажимается границей min. */
export function numParam(sp: URLSearchParams, key: string, def: number, min: number, max = Infinity): number {
  const raw = sp.get(key);
  const parsed = raw == null || raw.trim() === '' ? def : Number(raw);
  const v = Number.isFinite(parsed) ? parsed : def;
  return Math.min(max, Math.max(min, v));
}
