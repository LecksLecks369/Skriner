import type { MarketPulse } from './types';

/* Рыночный пульс: индекс страха и жадности (alternative.me) + глобальные метрики
   капитализации (CoinGecko). Кэш 10 минут — данные обновляются раз в час/день. */

const TTL = 10 * 60_000;

interface PulseGlobal {
  __screenerMarket: { cache: { ts: number; data: MarketPulse } | null };
}
const g = globalThis as unknown as PulseGlobal;
if (!g.__screenerMarket) g.__screenerMarket = { cache: null };
const cache = g.__screenerMarket;

const FNG_LABELS: Record<string, string> = {
  'extreme fear': 'экстр. страх',
  fear: 'страх',
  neutral: 'нейтрально',
  greed: 'жадность',
  'extreme greed': 'экстр. жадность',
};

async function fetchFng(): Promise<MarketPulse['fng']> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://api.alternative.me/fng/?limit=1', {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(t);
    const j = (await res.json()) as { data?: Array<{ value: string; value_classification: string }> };
    const d = j.data?.[0];
    if (!d) return null;
    const value = parseInt(d.value, 10);
    if (!isFinite(value)) return null;
    return { value, label: FNG_LABELS[d.value_classification?.toLowerCase()] || d.value_classification };
  } catch {
    return null;
  }
}

async function fetchGlobal(): Promise<{ btcDominance: number | null; mcapChange24h: number | null }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch('https://api.coingecko.com/api/v3/global', {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    clearTimeout(t);
    const j = (await res.json()) as {
      data?: { market_cap_percentage?: { btc?: number }; market_cap_change_percentage_24h_usd?: number };
    };
    return {
      btcDominance: j.data?.market_cap_percentage?.btc ?? null,
      mcapChange24h: j.data?.market_cap_change_percentage_24h_usd ?? null,
    };
  } catch {
    return { btcDominance: null, mcapChange24h: null };
  }
}

export async function getMarketPulse(): Promise<MarketPulse> {
  const hit = cache.cache;
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  const [fng, gl] = await Promise.all([fetchFng(), fetchGlobal()]);
  const data: MarketPulse = { ts: Date.now(), fng, ...gl };
  cache.cache = { ts: Date.now(), data };
  return data;
}

