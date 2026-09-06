const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function jget<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA }, cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface NetworkInfo {
  network: string; // TRC20 / ERC20 / ...
  chain: string;
  withdrawEnabled: boolean;
  depositEnabled: boolean;
  source: 'okx' | 'bitget';
}

const cache = new Map<string, { ts: number; nets: NetworkInfo[] }>();

/** Нормализация имён сетей к привычным меткам */
function canon(name: string): string {
  const n = name.toUpperCase();
  if (n.includes('TRC') || n === 'TRON') return 'TRC20';
  if (n.includes('ERC') || n === 'ETH') return 'ERC20';
  if (n.includes('BEP') || n === 'BSC') return 'BEP20';
  if (n.includes('ARBITRUM')) return 'Arbitrum';
  if (n.includes('OPTIMISM')) return 'Optimism';
  if (n.includes('SOLANA') || n === 'SOL') return 'SOL';
  if (n.includes('POLYGON') || n === 'MATIC') return 'Polygon';
  if (n.includes('AVALANCHE') || n === 'AVAX') return 'AVAX';
  if (n.includes('BASE')) return 'Base';
  if (n.includes('TON')) return 'TON';
  if (n.includes('SUI')) return 'SUI';
  return name.slice(0, 12);
}

const NOT_FOUND_NOTE = 'сети недоступны с этих бирж — проверьте вручную';
const TTL_MS = 3600_000;
const TTL_EMPTY_MS = 10 * 60_000; // «монеты нет» держим меньше: её могут листнуть позже

export async function fetchJsonLike(base: string): Promise<{ networks: NetworkInfo[]; matched: boolean; note?: string }> {
  const hit = cache.get(base);
  if (hit && Date.now() - hit.ts < (hit.nets.length ? TTL_MS : TTL_EMPTY_MS)) {
    return hit.nets.length
      ? { networks: hit.nets, matched: true }
      : { networks: [], matched: false, note: NOT_FOUND_NOTE };
  }

  const nets: NetworkInfo[] = [];

  // обе биржи опрашиваем параллельно: последовательно это удваивало задержку модалки
  const [okx, bg] = await Promise.all([
    // OKX: /api/v5/public/currencies?ccy=BTC
    jget<{ code: string; data?: Array<{ chains?: Array<{ chain?: string; canDep?: boolean; canWd?: boolean; ccY?: string }> }> }>(
      `https://www.okx.com/api/v5/public/currencies?ccy=${base}`
    ),
    // Bitget: /api/v2/spot/public/coins (все монеты одним запросом)
    jget<{ code: string; data?: Array<{ coin?: string; chains?: Array<{ chain?: string; withdrawable?: string | boolean; rechargeable?: string | boolean }> }> }>(
      'https://api.bitget.com/api/v2/spot/public/coins'
    ),
  ]);

  const okxChains = okx?.data?.[0]?.chains || [];
  for (const ch of okxChains) {
    if (!ch.chain) continue;
    nets.push({
      network: canon(ch.chain),
      chain: ch.chain,
      withdrawEnabled: !!ch.canWd,
      depositEnabled: !!ch.canDep,
      source: 'okx',
    });
  }

  const bgCoin = bg?.data?.find((c) => c.coin?.toUpperCase() === base);
  for (const ch of bgCoin?.chains || []) {
    if (!ch.chain) continue;
    nets.push({
      network: canon(ch.chain),
      chain: ch.chain,
      withdrawEnabled: ch.withdrawable === 'true' || ch.withdrawable === true,
      depositEnabled: ch.rechargeable === 'true' || ch.rechargeable === true,
      source: 'bitget',
    });
  }

  // дедуп по имени сети
  const seen = new Map<string, NetworkInfo>();
  for (const n of nets) {
    const prev = seen.get(n.network);
    if (!prev) seen.set(n.network, n);
    else {
      prev.withdrawEnabled = prev.withdrawEnabled || n.withdrawEnabled;
      prev.depositEnabled = prev.depositEnabled || n.depositEnabled;
    }
  }
  const uniq = [...seen.values()];

  // кэшируем именно дедуплицированный результат: раньше в кэш клался сырой массив,
  // и все повторные вызовы в течение часа отдавали дубли сетей без объединения флагов.
  // Пустой ответ кладём в кэш только если обе биржи реально ответили — иначе это сетевой сбой.
  if (uniq.length || (okx != null && bg != null)) cache.set(base, { ts: Date.now(), nets: uniq });

  return {
    networks: uniq,
    matched: uniq.length > 0,
    note: uniq.length ? undefined : NOT_FOUND_NOTE,
  };
}

