/* ---------------- Класс актива: крипта или TradFi ----------------

   Биржи листят в общий USDT-универсум перпы на акции, нефть, газ и золото.
   На Binance таких примерно 190 из 479. Их аномалии — фандинг в сотни
   процентов годовых, стоящий OI, нулевая волатильность ночью — следствие
   того, что базовый рынок закрыт, а не неэффективность крипторынка. В любом
   ранжировании по модулю метрики они занимают верх просто потому, что их
   обычный диапазон шире, чем экстремальный диапазон крипты.

   Класс берётся из справочников самих бирж, а не из списка имён: список
   устаревает с каждым новым листингом.
     Binance exchangeInfo — contractType TRADIFI_PERPETUAL, underlyingType
       EQUITY / KR_EQUITY / HK_EQUITY / COMMODITY;
     OKX instruments     — instCategory: 1 крипта, 3 акции, 4 товары
       (проверено: BTC/ETH/SOL = 1, MU = 3, XAU/CL = 4).

   Ни Bybit, ни Bitget, ни MEXC, ни BingX класс не публикуют — их инструменты
   классифицируются по совпадению тикера с двумя справочниками выше. */

export type AssetClass = 'crypto' | 'tradfi';
export type AssetClassFilter = AssetClass | 'all';

const TTL_MS = 60 * 60_000; // состав инструментов меняется листингами, не тиками
const TIMEOUT_MS = 9000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Токены, которые называются как металл, но торгуются 24/7 как обычная крипта */
const CRYPTO_DESPITE_NAME = new Set(['XAUTUSDT', 'PAXGUSDT']);

/**
 * Один и тот же актив на разных биржах назван по-разному: MEXC торгует серебро
 * как SILVER, Binance и OKX — как XAG. Алиас отправляет тикер в справочник
 * вместо того, чтобы гадать по имени. Сюда добавляются только НАБЛЮДЁННЫЕ
 * расхождения: угаданный алиас рискует спрятать настоящую монету с таким же
 * тикером (SILVER — серебро, но GOLD когда-то был игровым токеном).
 */
const TICKER_ALIAS: Record<string, string> = {
  SILVERUSDT: 'XAGUSDT', // MEXC, цена совпадает со спотом серебра
  USOILUSDT: 'CLUSDT', // WTI
  UKOILUSDT: 'BZUSDT', // Brent
};

/**
 * Запасная эвристика для тикеров, которых нет ни в одном справочнике.
 *
 * Семейство `NC**…2USD` — структурные продукты BingX на традиционные активы:
 * NCCO — товары, NCSI — индексы, NCSK — акции, NCFX — валютные пары. В живом
 * универсуме их 23 штуки и ни одного крипто-базиса.
 *
 * Индексы перечислены поимённо и НЕ по подстроке: SPX500 — это S&P 500, а SPX
 * без цифр — мемкоин SPX6900. Правило по подстроке убило бы настоящую монету.
 */
const TRADFI_BY_NAME =
  /STOCKUSDT$|^(XAG|WTI|BRENT|NATGAS|COPPER|CORN|WHEAT)USDT$|GOLD\d*USDUSDT$|^NC(CO|SI|SK|FX)[A-Z0-9]*USDT$|^(SPX500|SP500|NAS100|NASDAQ100|US30|DAX40|DJI30|RUSSELL2000)USDT$/;

async function fetchJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

let cached: { ts: number; map: Map<string, AssetClass> } | null = null;
let inflight: Promise<Map<string, AssetClass>> | null = null;

async function build(): Promise<Map<string, AssetClass>> {
  const m = new Map<string, AssetClass>();

  const [bin, okx] = await Promise.allSettled([
    fetchJson<{ symbols?: Array<{ symbol: string; contractType?: string; underlyingType?: string }> }>(
      'https://fapi.binance.com/fapi/v1/exchangeInfo'
    ),
    fetchJson<{ data?: Array<{ instId: string; instCategory?: string }> }>(
      'https://www.okx.com/api/v5/public/instruments?instType=SWAP'
    ),
  ]);

  if (bin.status === 'fulfilled') {
    for (const s of bin.value.symbols ?? []) {
      if (!s.symbol.endsWith('USDT')) continue;
      const tradfi =
        s.contractType === 'TRADIFI_PERPETUAL' || /EQUITY|COMMODITY/.test(s.underlyingType ?? '');
      m.set(s.symbol, tradfi ? 'tradfi' : 'crypto');
    }
  }

  if (okx.status === 'fulfilled') {
    for (const i of okx.value.data ?? []) {
      const sym = i.instId.replace(/-SWAP$/, '').replace('-', '');
      if (!sym.endsWith('USDT')) continue;
      const cls: AssetClass = i.instCategory === '3' || i.instCategory === '4' ? 'tradfi' : 'crypto';
      // расхождение между справочниками решается в пользу tradfi: один и тот же
      // тикер не бывает акцией на одной бирже и монетой на другой
      if (cls === 'tradfi' || !m.has(sym)) m.set(sym, cls);
    }
  }

  if (m.size === 0) throw new Error('оба справочника инструментов недоступны');
  return m;
}

/**
 * Справочник классов, кэш на час. Параллельные сканы делят один запрос:
 * без этого первый скан после старта дёргал бы exchangeInfo по разу на вызов.
 */
export async function assetClassMap(): Promise<Map<string, AssetClass>> {
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.map;
  if (inflight) return inflight;
  inflight = build().then(
    (map) => {
      cached = { ts: Date.now(), map };
      inflight = null;
      return map;
    },
    (e) => {
      inflight = null;
      throw e;
    }
  );
  return inflight;
}

/**
 * Класс одного инструмента по нормализованному тикеру (BTCUSDT).
 *
 * Неизвестный тикер считается КРИПТОЙ намеренно: две ошибки не равны по цене.
 * Спрятать настоящую монету из выдачи — потерянный сигнал, которого не видно;
 * пропустить незнакомый TradFi-перп — лишняя строка, которую видно по имени и
 * которая ловится добавлением тикера в справочник.
 */
export function classifySymbol(symbol: string, map: Map<string, AssetClass>): AssetClass {
  if (CRYPTO_DESPITE_NAME.has(symbol)) return 'crypto';
  const known = map.get(TICKER_ALIAS[symbol] ?? symbol);
  if (known) return known;
  return TRADFI_BY_NAME.test(symbol) ? 'tradfi' : 'crypto';
}

export function parseAssetClass(raw: string | null | undefined): AssetClassFilter {
  return raw === 'tradfi' || raw === 'all' ? raw : 'crypto';
}
