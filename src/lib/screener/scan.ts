import {
  EXCHANGES,
  type CoinRow,
  type ExDepth,
  type ExchangeFetchResult,
  type ExchangeId,
  type ExchangeRow,
  type ExchangeStatus,
  type KlinesResult,
  type ScanResponse,
} from './types';
import { fetchKlines, fetchTickers, pMap, fetchBingxPremium, fetchBingxOI, fetchBinanceOI, fetchBingxTaker, fetchOkxFunding, fetchOkxOI, fetchBitgetOI, fetchSpotPrices, fetchWhaleTrades, fetchOrderbook, fetchTape, fetchOkxLiquidations, fetchLsr, fetchFundingIntervals, normalizeFunding, type Book, type SpotMap, type TapeTrade, type WhaleInfo, type LiqInfo, type LsrInfo, type FundingIntervals } from './exchanges';
import { assetClassMap, classifySymbol, type AssetClass, type AssetClassFilter } from './assetClass';
import { computeScore, detectSweep, execSpreadPct, natrPct, volumeZ, cvdProxy, btcCorr } from './score';
import { detectBreakout, detectChop, detectDistribution, BREAKOUT_ALERT, CHOP_ER_MAX } from './setups';
import { amihudPct, algoProxyOf, analyzeBook, analyzeTape, assembleDeep, illiqProxyOf } from './liquidity';
import { seriesStore, appendJournal, journalSummary, appendSnapshot, symbolReputation, warmupSeries, scheduleSeriesPersist } from './store';
import { appendPattern, resolvePending, RECORD_THR, type PatternSignal } from './patterns';
import { autoPaper } from './paper';
import { getMarketPulse } from './market';

const TOP_DEFAULT = 80;
const KLINED_SYMBOLS = 80;
const SCAN_TTL = 45_000;
const TICKERS_TTL = 30_000;
const KLINES_TTL = 45_000;
const OI_TTL = 180_000;
const FUNDING_TTL = 300_000;
const OI_HISTORY_TTL = 300_000;
/* Порог записи в журнал и в историю спред-паттерна — одна константа из patterns.ts,
   потому что это граница популяции, по которой считается win-rate, и подпись под ним
   обязана читать ровно её. */
const JOURNAL_THRESHOLD = RECORD_THR.spreadNetPct;
export { BREAKOUT_ALERT };
const JOURNAL_COOLDOWN = 10 * 60 * 1000;

interface CacheGlobal {
  __screenerScan: {
    tickers: Partial<Record<ExchangeId, ExchangeFetchResult>>;
    tickersTs: number;
    klines: Map<string, { ts: number; res: KlinesResult | null }>;
    oi: Map<string, { ts: number; v: number | null }>;
    funding: Map<string, { ts: number; v: number | null }>;
    prem: Map<string, { ts: number; v: { rate: number | null; nextTs: number | null } | null }>;
    oiHistory: Map<string, { ts: number; d15: number | null; d1h: number | null }>;
    spot: { ts: number; data: SpotMap } | null;
    whale: Map<string, { ts: number; v: WhaleInfo | null }>;
    books: Map<string, { ts: number; v: Book | null }>;
    tapes: Map<string, { ts: number; v: TapeTrade[] | null }>;
    liq: Map<string, { ts: number; v: LiqInfo | null }>;
    lsr: Map<string, { ts: number; v: LsrInfo | null }>;
    scan: { ts: number; top: number; resp: ScanResponse } | null; // legacy-слот, живёт в globalThis после HMR
    scans: Map<string, { ts: number; resp: ScanResponse }>; // ключ: top + полоса оборота
    /* Идущие прямо сейчас сканы по ключу. Без этого каждый параллельный вызов запускал
       свой полный круг запросов ко всем биржам: один скан — это тикеры шести бирж плюс
       свечи, OI, фандинг, стаканы и ленты по 80 монетам. Скан дёргают одновременно
       SSE-стрим алертов (раз в 20с), опрос UI (раз в 30с) и внешние клиенты, поэтому
       наложения постоянны, и биржи начинают отвечать отказом СРАЗУ ВСЕ — в ответе
       остаётся ноль строк, сигналы не рождаются, а серии рвутся, из-за чего исходы
       потом нечем дооценить. Ожидающие переиспользуют один и тот же промис. */
    inflight: Map<string, Promise<ScanResponse>>;
  };
}
const g = globalThis as unknown as CacheGlobal;
if (!g.__screenerScan) {
  g.__screenerScan = {
    tickers: {},
    tickersTs: 0,
    klines: new Map(),
    oi: new Map(),
    funding: new Map(),
    prem: new Map(),
    oiHistory: new Map(),
    spot: null,
    whale: new Map(),
    books: new Map(),
    tapes: new Map(),
    liq: new Map(),
    lsr: new Map(),
    scan: null,
    scans: new Map(),
    inflight: new Map(),
  };
}
const cache = g.__screenerScan;
/* защитная инициализация: globalThis переживает HMR — старый объект может не иметь новых полей */
if (!cache.prem) cache.prem = new Map();
if (!cache.whale) cache.whale = new Map();
if (!cache.books) cache.books = new Map();
if (!(cache.inflight instanceof Map)) cache.inflight = new Map();
if (!cache.tapes) cache.tapes = new Map();
if (!cache.liq) cache.liq = new Map();
if (!cache.lsr) cache.lsr = new Map();
if (cache.spot === undefined) cache.spot = null;
if (cache.oi === undefined) cache.oi = new Map();
if (cache.funding === undefined) cache.funding = new Map();
if (cache.klines === undefined) cache.klines = new Map();
if (cache.oiHistory === undefined) cache.oiHistory = new Map();
if (!(cache.scans instanceof Map)) cache.scans = new Map();

function mapLimitKey<T>(key: string, map: Map<string, { ts: number; v: T }>, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = map.get(key);
  if (hit && Date.now() - hit.ts < ttl) return Promise.resolve(hit.v);
  return fn().then((v) => {
    map.set(key, { ts: Date.now(), v });
    return v;
  }).catch((e) => {
    console.error('[mapLimitKey]', key, e instanceof Error ? e.message : e);
    return null as unknown as T;
  });
}

/* Интервалы фандинга меняются редко — держим час, чтобы не дёргать
   instruments-info на каждом скане. */
const FUNDING_INTERVALS_TTL = 60 * 60_000;
let fundingIntervalsCache: { ts: number; v: FundingIntervals } | null = null;

async function getFundingIntervals(): Promise<FundingIntervals> {
  if (fundingIntervalsCache && Date.now() - fundingIntervalsCache.ts < FUNDING_INTERVALS_TTL) {
    return fundingIntervalsCache.v;
  }
  const v = await fetchFundingIntervals();
  // пустой ответ не кешируем на час: биржа могла просто не ответить
  if (v.bybit.size || v.bitget.size) fundingIntervalsCache = { ts: Date.now(), v };
  return v;
}

async function getTickers(): Promise<Partial<Record<ExchangeId, ExchangeFetchResult>>> {
  if (cache.tickers && Date.now() - cache.tickersTs < TICKERS_TTL) return cache.tickers;
  const results = await Promise.all(EXCHANGES.map((e) => fetchTickers(e.id)));
  const byEx: Partial<Record<ExchangeId, ExchangeFetchResult>> = {};
  for (const r of results) byEx[r.exchange] = r;
  cache.tickers = byEx;
  cache.tickersTs = Date.now();
  return byEx;
}

async function getKlines(ex: ExchangeId, native: string): Promise<KlinesResult | null> {
  const key = `${ex}:${native}`;
  const hit = cache.klines.get(key);
  if (hit && Date.now() - hit.ts < KLINES_TTL) return hit.res;
  const res = await fetchKlines(ex, native);
  cache.klines.set(key, { ts: Date.now(), res });
  if (cache.klines.size > 1200) {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [k, v] of cache.klines) if (v.ts < cutoff) cache.klines.delete(k);
  }
  return res;
}

/** ΔOI из истории Bybit (доступна сразу), 15м и 1ч */
async function getOiHistoryDelta(native: string): Promise<{ d15: number | null; d1h: number | null }> {
  const hit = cache.oiHistory.get(native);
  if (hit && Date.now() - hit.ts < OI_HISTORY_TTL) return { d15: hit.d15, d1h: hit.d1h };
  const out: { d15: number | null; d1h: number | null } = { d15: null, d1h: null };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(
      `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${native}&intervalTime=5min&limit=13`,
      { signal: ctrl.signal, cache: 'no-store' }
    );
    clearTimeout(t);
    const j = (await res.json()) as { retCode: number; result?: { list?: Array<{ openInterest: string }> } };
    const list = j.result?.list;
    if (j.retCode === 0 && list && list.length >= 4) {
      const arr = list.map((x) => parseFloat(x.openInterest)).reverse(); // старые первыми
      const last = arr[arr.length - 1];
      if (last > 0) {
        const base15 = arr[arr.length - 4];
        const base1h = arr.length >= 13 ? arr[arr.length - 13] : null;
        out.d15 = ((last - base15) / base15) * 100;
        if (base1h && base1h > 0) out.d1h = ((last - base1h) / base1h) * 100;
      }
    }
  } catch {
    /* нет данных */
  }
  cache.oiHistory.set(native, { ts: Date.now(), ...out });
  return out;
}

/** Спот-цены для спот×перпетуал базиса (кэш 90с) */
async function getSpotPricesCached(): Promise<SpotMap> {
  if (cache.spot && Date.now() - cache.spot.ts < 90_000) return cache.spot.data;
  const data = await fetchSpotPrices();
  cache.spot = { ts: Date.now(), data };
  return data;
}

/** Прореживание кэшей стакана/ленты (после 800 ключей чистим старше 15 минут) */
function pruneMap(m: Map<string, { ts: number; v: unknown }>) {
  if (m.size <= 800) return;
  const cutoff = Date.now() - 15 * 60_000;
  for (const [k, v] of m) if (v.ts < cutoff) m.delete(k);
}

/** Китовые сделки Bybit (кэш 60с) */
async function getWhale(native: string): Promise<WhaleInfo | null> {
  const hit = cache.whale.get(native);
  if (hit && Date.now() - hit.ts < 60_000) return hit.v;
  const v = await fetchWhaleTrades(native).catch(() => null);
  cache.whale.set(native, { ts: Date.now(), v });
  if (cache.whale.size > 400) {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, val] of cache.whale) if (val.ts < cutoff) cache.whale.delete(k);
  }
  return v;
}

/* ---------------- Универсум сканирования ----------------

   До этого универсум был жёстко «топ-N по обороту», и вся дальнейшая логика — скор,
   стакан, паттерны, неликвид-раздел — работала по 80 САМЫМ ЛИКВИДНЫМ монетам рынка.
   На живом скане минимальный оборот в выдаче был $21M за сутки: неликвида там нет
   по построению, а illiqProxy мерил «наименее ликвидную из очень ликвидных».
   Полоса оборота делает выбор явным: снизу отсекаются мёртвые книги, сверху —
   массовые монеты, где неэффективность вычищена. */
export interface Universe {
  minTurnoverUsd: number;
  maxTurnoverUsd: number;
  /** Как выбираются N монет из полосы: 'top' — самые оборотистые, 'stratified' — вся полоса */
  sampling?: 'top' | 'stratified';
}

export const UNIVERSE_ALL: Universe = { minTurnoverUsd: 0, maxTurnoverUsd: Number.MAX_SAFE_INTEGER, sampling: 'top' };
/** Полоса неликвида по умолчанию: $0.3M–$20M за 24ч, с равномерным покрытием всей полосы */
export const UNIVERSE_ILLIQUID: Universe = { minTurnoverUsd: 300_000, maxTurnoverUsd: 20_000_000, sampling: 'stratified' };

/** Число слоёв при stratified-отборе: 80 мест / 8 слоёв = по 10 монет на порядок оборота */
const STRATA = 8;

/**
 * Отбор монет из полосы.
 *
 * 'top' — как раньше: N самых оборотистых. Для общего универсума это и нужно.
 *
 * 'stratified' — полоса делится на слои, равные по ЛОГАРИФМУ оборота, и из каждого
 * берётся своя квота. Без этого фильтр полосы не даёт того, ради чего он ставился:
 * ранжирование по обороту внутри полосы возвращает её верхний край, и на полосе
 * $0.3–20M выдача начиналась с $7M — нижние три четверти диапазона не появлялись
 * вовсе. Логарифм, а не линейная шкала: между $0.3M и $3M разница в поведении книги
 * больше, чем между $10M и $20M, а линейные слои сложили бы весь этот участок в один.
 * Внутри слоя порядок по обороту убыванием — при нехватке данных первыми выпадают
 * самые тонкие монеты слоя, а не случайные.
 */
/* Одинаковый нормализованный тикер на разных биржах не гарантирует один и тот же
   инструмент: встречаются разный базовый актив под тем же именем и разный множитель
   контракта (X против 1000X). Цены тогда расходятся в разы, и разрыв выглядит как
   гигантский арбитраж: на живом скане ON котировался по $71.17 на OKX и по $0.1957
   на MEXC — «нетто-спред 36266%», который уходил в журнал, в историю паттернов и в
   бумажные сделки. Настоящий межбиржевой разрыв перпетуала — доли процента, поэтому
   расхождение в разы означает не неэффективность, а разные инструменты.

   Порог с большим запасом над любым реальным спредом: всё, что дальше, отбрасывается
   вместе со всеми данными этой биржи по монете — её клайны, OI и фандинг относятся к
   другому контракту и в строке не участвуют. На топе по обороту это почти не
   встречалось, в полосе неликвида нашлось сразу на первом же скане. */
const VENUE_PRICE_TOLERANCE = 0.10;

function dropMismatchedVenues(agg: Map<string, { symbol: string; per: Map<ExchangeId, { price: number; turnover: number }> }>) {
  let dropped = 0;
  const examples: string[] = [];
  for (const a of agg.values()) {
    if (a.per.size < 2) continue;
    const entries = [...a.per.entries()].filter(([, p]) => p.price > 0).sort((x, y) => x[1].price - y[1].price);
    if (entries.length < 2) continue;

    /* Кластеризация по цене, а не отбор по медиане: при расколе 2×2 (две биржи по $71,
       две по $0.19) медиана падает между кластерами и объявляет чужими ВСЕ четыре,
       уничтожая и тот спред, который был настоящим. Соседние по цене биржи, стоящие
       ближе допуска, — один инструмент; выигрывает кластер с наибольшим оборотом. */
    const clusters: (typeof entries)[] = [[entries[0]]];
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1][1].price;
      if (entries[i][1].price / prev - 1 > VENUE_PRICE_TOLERANCE) clusters.push([entries[i]]);
      else clusters[clusters.length - 1].push(entries[i]);
    }
    if (clusters.length === 1) continue;

    const turnoverOf = (c: typeof entries) => c.reduce((s, [, p]) => s + (p.turnover || 0), 0);
    const winner = clusters.slice().sort((x, y) => turnoverOf(y) - turnoverOf(x))[0];
    for (const [ex] of entries) {
      if (!winner.some(([wx]) => wx === ex)) {
        a.per.delete(ex);
        dropped++;
      }
    }
    if (examples.length < 5) examples.push(a.symbol);
  }
  if (dropped) {
    console.warn(`[scan] отброшено котировок другого инструмента: ${dropped} (${examples.join(', ')})`);
  }
}

/* ---------------- Граница популяции: что вообще является инструментом скринера ----

   Скринер измеряет бессрочные контракты, котируемые в USDT. Биржи отдают в тех же
   списках тикеров ещё три вида инструментов, и каждый из них ломает измерение
   по-своему:

     квота не USDT (BTCUSDC, BCHUSD, BNBUSD1, байбитовские BTCPERP) — цена в другой
       валюте. ETHPERP котируется в USDC и сравнивался с ETHUSDT: «межбиржевой спред»
       на нём был базисом USDC/USDT, а не разрывом между биржами;
     датированные поставочные (BTCUSDT-25DEC26) — другой контракт с собственным
       базисом к перпу, и чем дальше экспирация, тем больше разрыв;
     стейбл к стейблу (USDCUSDT) — цена приклеена к единице: такой инструмент не
       может дать ни один измеряемый исход, но исправно занимает место в выборке.

   Правило проверено на ПОЛНОЙ живой популяции (2099 нормализованных тикеров с пяти
   бирж, 2026-09-10), а не на случаях, которые его породили: 239 тикеров с неUSDT-квотой
   (включая все 40 датированных), 4 стейбла к стейблу — 11.6% универсума. Ложных
   срабатываний на этой популяции нет; USDGOUSDT (настоящий токен) и USDJPYUSDT
   (форекс — дело классификатора класса актива) под правило НЕ попадают. */
const STABLE_BASES = new Set([
  // наблюдены в живом универсуме 2026-09-10
  'USDC', 'USDE', 'USD1', 'RLUSD',
  // того же семейства, пока не листятся: добавлены заранее, чтобы листинг не попал в выборку
  'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'PYUSD', 'USDD', 'USDS',
]);

/** Незнакомый тикер считается пригодным намеренно: спрятанная монета — потерянный
    сигнал, которого не видно, лишняя строка видна по имени и правится списком. */
function isScreenableSymbol(symbol: string): boolean {
  if (!symbol.endsWith('USDT')) return false; // чужая квота, PERP-суффикс, датированные
  return !STABLE_BASES.has(symbol.slice(0, -4));
}

function selectUniverse<T extends { maxTurnover: number }>(candidates: T[], top: number, uni: Universe): T[] {
  const sorted = [...candidates].sort((x, y) => y.maxTurnover - x.maxTurnover);
  if (uni.sampling !== 'stratified' || sorted.length <= top) return sorted.slice(0, top);

  const lo = Math.log10(Math.max(1, Math.min(...sorted.map((x) => x.maxTurnover))));
  const hi = Math.log10(Math.max(1, Math.max(...sorted.map((x) => x.maxTurnover))));
  if (!(hi > lo)) return sorted.slice(0, top);

  const buckets: T[][] = Array.from({ length: STRATA }, () => []);
  for (const c of sorted) {
    const pos = (Math.log10(Math.max(1, c.maxTurnover)) - lo) / (hi - lo);
    buckets[Math.min(STRATA - 1, Math.floor(pos * STRATA))].push(c);
  }

  /* Квота на слой, но пустые и неполные слои не должны съедать места: сначала берём
     по квоте, затем добираем остаток по обороту убыванием. */
  const quota = Math.ceil(top / STRATA);
  const picked: T[] = [];
  const taken = new Set<T>();
  for (const b of buckets) {
    for (const c of b.slice(0, quota)) {
      picked.push(c);
      taken.add(c);
    }
  }
  for (const c of sorted) {
    if (picked.length >= top) break;
    if (!taken.has(c)) {
      picked.push(c);
      taken.add(c);
    }
  }
  return picked.slice(0, top);
}

/** Сколько мест в deep-блоке (стакан + лента) резервируется под самые неликвидные монеты */
const DEEP_TARGETS = 40;
const DEEP_ILLIQ_QUOTA = 10;

async function doScan(
  top: number,
  refExchangePref: ExchangeId | 'auto',
  uni: Universe = UNIVERSE_ALL,
  assetClass: AssetClassFilter = 'crypto'
): Promise<ScanResponse> {
  warmupSeries(); // прогрев: восстановить серии с диска до первых записей
  const now = Date.now();

  /* Бюджет скана по настенным часам. Без него скан идёт столько, сколько нужно всем
     стадиям, и при деградации сети это минуты: замер 2026-09-11 — 127 с при живой
     сети и >280 с при медленной, когда недоступны даже Google Fonts. Клиент за это
     время не получает НИЧЕГО — таблица пуста, хотя цены и спреды были готовы на
     первой стадии. Поэтому обогащение (OI, спот-базис, стакан с лентой, ликвидации)
     за пределами бюджета пропускается, а строки отдаются.

     Пропуск обязан быть виден: молчаливо усечённый ответ неотличим от сломанной
     биржи, поэтому список пропущенных стадий уезжает в ответе. */
  const SCAN_BUDGET_MS = 45_000;
  /* Стадии срезаются в порядке стоимости, а дороже всех — стакан. Но стакан
     единственный, кто считает слипейдж: без него netExecPct = null, бумажный
     симулятор не открывает сделок, а алерт всё равно уходит по сырому спреду,
     из которого издержки исполнения не вычтены. Замер: 24 живых скана подряд,
     стадия стакана пропущена во всех 24. Деградация имела направление —
     система теряла ровно то слагаемое, которое может отменить вердикт, и
     сходилась к своему самому выгодному ответу.

     Поэтому у стакана есть резерв: необязательное обогащение (свечи, OI,
     спот-базис, киты, ликвидации) уступает место раньше и меряется по
     budgetLeft(), а стадия стакана — по deepBudgetLeft() до полного дедлайна. */
  const DEEP_RESERVE_MS = 15_000;
  const deadline = now + SCAN_BUDGET_MS;
  const budgetLeft = () => deadline - DEEP_RESERVE_MS - Date.now();
  const deepBudgetLeft = () => deadline - Date.now();
  const skippedStages = new Set<string>();
  const [tickers, fundingIntervals] = await Promise.all([getTickers(), getFundingIntervals()]);
  const okExchanges = EXCHANGES.filter((e) => tickers[e.id]?.ok);

  // 1. Объединение тикеров по нормализованному символу
  interface Agg {
    symbol: string;
    per: Map<ExchangeId, { native: string; price: number; bid: number | null; ask: number | null; turnover: number; funding: number | null; oi: number | null; oiUsd: number | null; nfTs: number | null }>;
  }
  const agg = new Map<string, Agg>();
  for (const ex of okExchanges) {
    const r = tickers[ex.id]!;
    for (const t of r.tickers) {
      let a = agg.get(t.symbol);
      if (!a) {
        a = { symbol: t.symbol, per: new Map() };
        agg.set(t.symbol, a);
      }
      a.per.set(ex.id, {
        native: t.nativeSymbol,
        price: t.price,
        bid: t.bid ?? null,
        ask: t.ask ?? null,
        turnover: t.turnoverUsd,
        funding: t.fundingRate ?? null,
        oi: t.oi ?? null,
        oiUsd: t.oiUsd ?? null,
        nfTs: t.nextFundingTs ?? null,
      });
    }
  }

  // 1b. Отсев бирж, торгующих под этим тикером другой инструмент
  dropMismatchedVenues(agg);

  /* 1c. Класс актива. Отсев обязан идти ДО полосы оборота и отбора топ-N:
     TradFi-перпы оборотисты (нефть и золото дают больше $1B в сутки), и если
     резать их после отбора, они сначала займут места в выдаче, а крипта
     недоберёт монет до top. */
  const clsMap = await assetClassMap().catch((e) => {
    console.error('[scan] справочник классов недоступен, класс не фильтруется:', e);
    return new Map<string, AssetClass>();
  });
  /* Граница популяции применяется ДО фильтра класса и независимо от него: чужая квота,
     датированный контракт и стейбл к стейблу непригодны при любом значении assetClass. */
  let excludedAsNonPerp = 0;
  const nonPerpExamples: string[] = [];
  for (const sym of [...agg.keys()]) {
    if (isScreenableSymbol(sym)) continue;
    agg.delete(sym);
    excludedAsNonPerp += 1;
    if (nonPerpExamples.length < 5) nonPerpExamples.push(sym);
  }
  if (excludedAsNonPerp) {
    console.warn(`[scan] не инструменты скринера: ${excludedAsNonPerp} (${nonPerpExamples.join(', ')})`);
  }

  const classOf = (s: string): AssetClass => classifySymbol(s, clsMap);
  let excludedByClass = 0;
  if (assetClass !== 'all' && clsMap.size > 0) {
    for (const sym of [...agg.keys()]) {
      if (classOf(sym) !== assetClass) {
        agg.delete(sym);
        excludedByClass += 1;
      }
    }
  }

  // 2. Полоса оборота, затем отбор внутри неё (см. selectUniverse)
  const inBand = [...agg.values()]
    .map((a) => ({ a, maxTurnover: Math.max(...[...a.per.values()].map((p) => p.turnover)) }))
    .filter((x) => x.maxTurnover >= uni.minTurnoverUsd && x.maxTurnover <= uni.maxTurnoverUsd);
  const ranked = selectUniverse(inBand, top, uni);

  // 3. Клайны + BingX extras
  type Extra = {
    funding?: number | null;
    oi?: number | null;
    taker?: number | null;
    nextTs?: number | null;
    oiDelta?: { d15: number | null; d1h: number | null };
  };
  const klinesBy = new Map<string, Map<ExchangeId, KlinesResult>>();
  const extras = new Map<string, Map<ExchangeId, Extra>>();

  await pMap(
    ranked,
    async ({ a }) => {
      /* Свечи нужны для волатильности, скора и сетапов, но при исчерпанном бюджете
         строка без них полезнее отсутствия строки: цена, котировки и спред уже есть
         из тикеров. Монеты идут по убыванию оборота, поэтому обрезается хвост. */
      if (budgetLeft() <= 0) {
        skippedStages.add('свечи');
        return;
      }
      const kl = new Map<ExchangeId, KlinesResult>();
      const ex = new Map<ExchangeId, Extra>();
      await Promise.all(
        [...a.per.entries()].map(async ([exId, p]) => {
          if (exId === 'ourbit') return;
          const res = await getKlines(exId, p.native);
          if (res && res.candles.length > 5) kl.set(exId, res);
          if (exId === 'bingx') {
            const [prem, oi] = await Promise.all([
              mapLimitKey(`bingx:prem:${p.native}`, cache.prem, FUNDING_TTL, () => fetchBingxPremium(p.native)),
              mapLimitKey(`bingx:oi:${p.native}`, cache.oi, OI_TTL, () => fetchBingxOI(p.native)),
            ]);
            ex.set('bingx', { funding: prem?.rate ?? null, oi, taker: null, nextTs: prem?.nextTs ?? null });
          }
        })
      );
      klinesBy.set(a.symbol, kl);
      if (ex.size) extras.set(a.symbol, ex);
    },
    6
  );

  // 4. OKX funding/OI + Bitget OI + Bybit ΔOI-история — для топ-40 по обороту
  const top40 = ranked.slice(0, 40);
  await Promise.all([
    ...top40.map(async ({ a }) => {
      if (budgetLeft() <= 0) {
        skippedStages.add('OI бирж');
        return;
      }
      const okxP = a.per.get('okx');
      if (okxP) {
        const [funding, oi] = await Promise.all([
          mapLimitKey(`okx:f:${okxP.native}`, cache.funding, FUNDING_TTL, () => fetchOkxFunding(okxP.native)),
          mapLimitKey(`okx:oi:${okxP.native}`, cache.oi, OI_TTL, () => fetchOkxOI(okxP.native)),
        ]);
        if (funding != null || oi != null) {
          const m = extras.get(a.symbol) || new Map<ExchangeId, Extra>();
          m.set('okx', { funding, oi, ...m.get('okx') });
          extras.set(a.symbol, m);
        }
      }
      const bgP = a.per.get('bitget');
      if (bgP) {
        const oi = await mapLimitKey(`bitget:oi:${bgP.native}`, cache.oi, OI_TTL, () => fetchBitgetOI(bgP.native));
        if (oi != null) {
          const m = extras.get(a.symbol) || new Map<ExchangeId, Extra>();
          m.set('bitget', { oi, ...m.get('bitget') });
          extras.set(a.symbol, m);
        }
      }
      /* Binance отдаёт OI только по одному символу за запрос — как OKX и Bitget,
         поэтому догружается здесь же, для топа, а не для всех 766 символов. */
      const bnP = a.per.get('binance');
      if (bnP) {
        const oi = await mapLimitKey(`binance:oi:${bnP.native}`, cache.oi, OI_TTL, () => fetchBinanceOI(bnP.native));
        if (oi != null) {
          const m = extras.get(a.symbol) || new Map<ExchangeId, Extra>();
          m.set('binance', { oi, ...m.get('binance') });
          extras.set(a.symbol, m);
        }
      }
    }),
    ...top40.map(async ({ a }) => {
      if (!a.per.has('bybit')) return;
      const d = await getOiHistoryDelta(a.per.get('bybit')!.native);
      const m = extras.get(a.symbol) || new Map<ExchangeId, Extra>();
      m.set('bybit', { ...m.get('bybit'), ...(d.d15 != null ? { oiDelta: d } : {}) } as Extra);
      extras.set(a.symbol, m);
    }),
  ]);

  // 4b. Premium v3: BTC-режим, спот-базис, киты, репутация монет
  const [btcKl, spot] = await Promise.all([getKlines('bybit', 'BTCUSDT'), getSpotPricesCached()]);
  const btcCandles = btcKl?.candles || [];
  const repMap = symbolReputation();
  const whaleMap = new Map<string, WhaleInfo | null>();
  await pMap(
    ranked.slice(0, 30),
    async ({ a }) => {
      if (budgetLeft() <= 0) {
        skippedStages.add('спот-базис и киты');
        return;
      }
      const p = a.per.get('bybit');
      if (!p) return;
      whaleMap.set(a.symbol, await getWhale(p.native));
    },
    6
  );

  // 5. Построение строк
  const feeById = Object.fromEntries(EXCHANGES.map((e) => [e.id, e.takerFee])) as Record<ExchangeId, number>;
  const rows: CoinRow[] = [];
  /* Спред-сигналы, отложенные до конца deep-блока: слипейдж стакана известен только
     там, а исход спреда обязан считаться той же моделью издержек, что и бумажная
     сделка. Порог и кулдаун при этом отрабатывают на своём месте — популяция та же. */
  const deferredSpreadSignals: Array<Omit<PatternSignal, 'key'>> = [];
  const amihudBySym = new Map<string, number | null>();
  // свечи, по которым считались сетапы: нужны для пересчёта после ленты и ликвидаций
  const bestKlBySym = new Map<string, KlinesResult>();

  for (const { a } of ranked) {
    const prices = [...a.per.values()].map((p) => p.price).sort((x, y) => x - y);
    const price = prices[Math.floor(prices.length / 2)];
    const hi = prices[prices.length - 1];
    const lo = prices[0];
    const mid = (hi + lo) / 2;
    // разброс last-цен; ниже заменяется на разрыв котировок, если он известен
    let crossSpreadPct = hi > 0 ? ((hi - lo) / ((hi + lo) / 2)) * 100 : null;

    // эталонная биржа
    let refEx: ExchangeId;
    if (refExchangePref !== 'auto' && a.per.has(refExchangePref)) refEx = refExchangePref;
    else {
      refEx = [...a.per.entries()].sort((x, y) => y[1].turnover - x[1].turnover)[0][0];
    }
    const refPrice = a.per.get(refEx)!.price;
    const refSpreadPct =
      refPrice > 0 ? (Math.max(Math.abs(hi - refPrice), Math.abs(lo - refPrice)) / refPrice) * 100 : null;

    /* Нетто-спред строится по КОТИРОВКАМ, а не по ценам последних сделок:
       продаём в чужой bid, покупаем в чужой ask. Спред из last-цен измеряет
       расхождение времени последних принтов, а не разрыв котировок, и регулярно
       показывает разрыв там, где книги перекрываются. Биржа без котировок в
       спред не допускается: её last-цена дала бы фантомный разрыв. */
    let bestBid: { exchange: ExchangeId; price: number } | undefined;
    let bestAsk: { exchange: ExchangeId; price: number } | undefined;
    let quotedVenues = 0;
    for (const [exId, p] of a.per) {
      if (p.bid == null || p.ask == null) continue;
      quotedVenues++;
      if (!bestBid || p.bid > bestBid.price) bestBid = { exchange: exId, price: p.bid };
      if (!bestAsk || p.ask < bestAsk.price) bestAsk = { exchange: exId, price: p.ask };
    }
    const quoteBased = quotedVenues >= 2;
    let netSpreadPct: number | null = null;
    if (quoteBased && bestBid && bestAsk && bestBid.exchange !== bestAsk.exchange) {
      const gross = ((bestBid.price - bestAsk.price) / bestAsk.price) * 100;
      const fees = (feeById[bestBid.exchange] + feeById[bestAsk.exchange]) * 100;
      netSpreadPct = gross - fees;
      // разрыв котировок вытесняет разброс last-цен: отрицательный = книги перекрываются
      crossSpreadPct = gross;
    }

    // серии в стор
    for (const [exId, p] of a.per) {
      seriesStore.addPrice(a.symbol, exId, now, p.price);
      /* Котировки по биржам: путь разрыва для оценки исхода обязан считаться по
         той же паре и тем же выражением, что и вход. */
      if (p.bid != null && p.ask != null && p.bid > 0 && p.ask > 0) {
        seriesStore.addQuote(a.symbol, exId, now, p.bid, p.ask);
      }
      if (p.oi != null) seriesStore.addOi(a.symbol, exId, now, p.oi);
      if (p.funding != null) seriesStore.addFunding(a.symbol, exId, now, p.funding);
      const ext = extras.get(a.symbol)?.get(exId);
      if (ext?.oi != null) seriesStore.addOi(a.symbol, exId, now, ext.oi);
      if (ext?.funding != null) seriesStore.addFunding(a.symbol, exId, now, ext.funding);
    }
    /* z-score СНАЧАЛА, запись в серию — после. Порядок был обратный, и текущее
       значение попадало в собственную историю: оно тянуло среднее к себе и
       раздувало дисперсию, то есть занижало z ровно на всплеске — там, где по
       нему теперь принимается решение об алерте. Контроль не может включать в
       себя измеряемую единицу. */
    const zScore = crossSpreadPct != null ? seriesStore.spreadZScore(a.symbol, crossSpreadPct) : null;
    if (crossSpreadPct != null) seriesStore.addCrossSpread(a.symbol, now, crossSpreadPct);

    // метрики per exchange
    const exRows: ExchangeRow[] = [];
    let dOi15: number | null = null;
    let dOi1h: number | null = null;
    let sweepBest: ReturnType<typeof detectSweep> = null;
    let natrMax: number | null = null;
    let volZMax: number | null = null;

    for (const [exId, p] of a.per) {
      const kl = klinesBy.get(a.symbol)?.get(exId);
      const np = kl ? natrPct(kl.candles) : null;
      const vz = kl ? volumeZ(kl.candles) : null;
      const sw = kl && kl.intervalMin <= 3 ? detectSweep(kl.candles, kl.intervalMin) : null;
      const ext = extras.get(a.symbol)?.get(exId);
      let d15: number | null = null;
      let d1h: number | null = null;
      if (exId === 'bybit' && ext && 'oiDelta' in ext && ext.oiDelta) {
        d15 = ext.oiDelta.d15;
        d1h = ext.oiDelta.d1h;
      }
      if (d15 == null) d15 = seriesStore.dOiPct(a.symbol, 15 * 60_000);
      if (d1h == null) d1h = seriesStore.dOiPct(a.symbol, 60 * 60_000);
      // берём самое сильное движение OI по модулю, сохраняя его знак (отток так же важен, как приток)
      if (d15 != null && (dOi15 == null || Math.abs(d15) > Math.abs(dOi15))) dOi15 = d15;
      if (d1h != null && (dOi1h == null || Math.abs(d1h) > Math.abs(dOi1h))) dOi1h = d1h;
      if (np != null && (natrMax == null || np > natrMax)) natrMax = np;
      if (vz != null && (volZMax == null || vz > volZMax)) volZMax = vz;
      if (sw && (!sweepBest || sw.ageMin < sweepBest.ageMin)) sweepBest = sw;
      exRows.push({
        exchange: exId,
        price: p.price,
        bid: p.bid,
        ask: p.ask,
        fundingRate: p.funding ?? ext?.funding ?? null,
        /* У Binance fundingInfo перечисляет не все символы; отсутствующие начисляются
           раз в 8 часов — это опубликованный дефолт биржи, поэтому ставка считается
           нормированной, а не «период неизвестен». Для остальных площадок отсутствие
           записи по-прежнему означает именно неизвестный период. */
        fundingIntervalMin:
          fundingIntervals[exId as 'bybit' | 'bitget' | 'binance']?.get(a.symbol) ??
          (exId === 'binance' ? 480 : null),
        oiUsd: p.oiUsd ?? (p.oi != null ? p.oi * p.price : ext?.oi != null ? ext.oi * p.price : null),
        dOiPct5m: null,
        dOiPct15m: d15,
        dOiPct1h: d1h,
        natrPct: np,
        volZ: vz,
        sweep: sw,
        cvdTaker: exId === 'bingx' ? (ext?.taker ?? null) : null,
      });
    }

    /* Фандинг сравниваем только приведённым к 8 часам: часть символов считается
       раз в 4ч, и без нормировки один порог скоринга смешивает разные величины. */
    const fundingVals = exRows
      .map((r) => normalizeFunding(r.fundingRate, r.fundingIntervalMin))
      .filter((v): v is number => v != null);
    const fundingAbs = fundingVals.length ? Math.max(...fundingVals.map(Math.abs)) : null;
    // известен ли интервал хотя бы у одной ноги: если нет — ставка взята как есть
    const fundingNormalized = exRows.some((r) => r.fundingRate != null && r.fundingIntervalMin != null);
    const oiUsdVals = exRows.map((r) => r.oiUsd).filter((v): v is number => v != null);
    const oiUsdMax = oiUsdVals.length ? Math.max(...oiUsdVals) : null;
    const cvd = exRows.find((r) => r.cvdTaker != null)?.cvdTaker ?? null;

    // Premium v3: спот×перпетуал базис
    let spotBasisPct: number | null = null;
    let spotBasis: { ex: ExchangeId; perp: number; spot: number; pct: number } | null = null;
    for (const [exId, p] of a.per) {
      const sp = spot[exId]?.get(a.symbol);
      if (!sp || sp <= 0) continue;
      const pct = ((p.price - sp) / sp) * 100;
      if (spotBasisPct == null || Math.abs(pct) > Math.abs(spotBasisPct)) {
        spotBasisPct = pct;
        spotBasis = { ex: exId, perp: p.price, spot: sp, pct };
      }
    }
    // разброс фандинга между биржами — тоже по 8-часовым эквивалентам
    const fundRatesAll = exRows
      .map((r) => normalizeFunding(r.fundingRate, r.fundingIntervalMin))
      .filter((v): v is number => v != null);
    const fundingSpreadPct = fundRatesAll.length >= 2 ? (Math.max(...fundRatesAll) - Math.min(...fundRatesAll)) * 100 : null;
    // ближайший следующий фандинг
    let fundingNextTs = 0;
    let fundingNextFrom: ExchangeId | null = null;
    for (const [exId, p] of a.per) {
      if (p.nfTs && p.nfTs > now && (!fundingNextTs || p.nfTs < fundingNextTs)) {
        fundingNextTs = p.nfTs;
        fundingNextFrom = exId;
      }
    }
    const extsRow = extras.get(a.symbol);
    if (extsRow) {
      for (const [exId, ext] of extsRow) {
        if (ext.nextTs && ext.nextTs > now && (!fundingNextTs || ext.nextTs < fundingNextTs)) {
          fundingNextTs = ext.nextTs;
          fundingNextFrom = exId;
        }
      }
    }
    const fundingNextMin = fundingNextTs ? Math.round((fundingNextTs - now) / 60000) : null;

    const sc = computeScore({
      natrPct: natrMax,
      dOiPct15m: dOi15,
      dOiPct1h: dOi1h,
      sweep: sweepBest,
      volZ: volZMax,
      netSpreadPct,
      zScore,
      coverage: a.per.size,
      fundingAbs,
    });

    // спарклайны + прокси-CVD + корреляция с BTC
    let spark: number[] = [];
    let bestKl: KlinesResult | null = null;
    const klMap = klinesBy.get(a.symbol);
    if (klMap && klMap.size) {
      const bestEx = [...a.per.entries()].sort((x, y) => y[1].turnover - x[1].turnover)[0][0];
      bestKl = klMap.get(bestEx) || [...klMap.values()][0] || null;
      spark = bestKl ? bestKl.candles.slice(-60).map((c) => c.c) : [];
    }
    const cvdProxyV = bestKl ? cvdProxy(bestKl.candles) : null;
    const corrV = bestKl && btcCandles.length > 31 ? btcCorr(bestKl.candles, btcCandles) : null;
    const wh = whaleMap.get(a.symbol) ?? null;
    const repEntry = repMap[a.symbol] ?? null;
    const spreadSpark = seriesStore.getSpreadHistory(a.symbol).slice(-90).map((p) => p.v);

    // Неликвид: дешёвые прокси для всех строк (без запросов стакана/ленты)
    const amihudV = bestKl ? amihudPct(bestKl.candles) : null;
    amihudBySym.set(a.symbol, amihudV);
    const turnoverMax = Math.max(...[...a.per.values()].map((p) => p.turnover));
    const illiqProxyV = illiqProxyOf(amihudV, turnoverMax, crossSpreadPct);
    const algoProxyV = algoProxyOf(volZMax, dOi15, sweepBest?.ageMin ?? null);

    /* Сетапы движения. Порядок важен: ёрш считается первым, потому что он входит
       в готовность пробоя штрафом — в пиле граница диапазона протыкается постоянно.
       Лента, ликвидации и L/S сюда ещё не пришли (блоки 5a/5b), поэтому те же
       детекторы пересчитываются ниже для монет, у которых эти данные появятся. */
    if (bestKl) bestKlBySym.set(a.symbol, bestKl);
    const fundingSignedV = fundingVals.length
      ? fundingVals.reduce((x, y) => (Math.abs(y) > Math.abs(x) ? y : x), 0)
      : null;
    const flowV = cvd ?? cvdProxyV;
    const chopV = bestKl ? detectChop(bestKl.candles, null) : null;
    const breakoutV = bestKl
      ? detectBreakout(bestKl.candles, {
          volZ: volZMax,
          dOiPct15m: dOi15,
          cvd: flowV,
          chopScore: chopV?.score ?? 0,
        })
      : null;
    const distV = bestKl
      ? detectDistribution(bestKl.candles, {
          natrPct: natrMax,
          dOiPct15m: dOi15,
          cvd: flowV,
          tape: null,
          whaleNetUsd: wh?.netUsd ?? null,
          lsrLongPct: null,
          fundingSigned: fundingSignedV,
          liqLongUsd: null,
          liqShortUsd: null,
        })
      : null;

    seriesStore.trackSignalAge(a.symbol, now, JOURNAL_THRESHOLD, netSpreadPct);
    const age = seriesStore.signalAge(a.symbol, now);

    rows.push({
      symbol: a.symbol,
      assetClass: classOf(a.symbol),
      bestBid,
      bestAsk,
      price,
      turnoverUsd: turnoverMax,
      coverage: a.per.size,
      exchanges: exRows,
      crossSpreadPct,
      refSpreadPct,
      netSpreadPct,
      netExecPct: null, // заполняется после deep-блока, когда известен стакан обеих ног
      quoteBased,
      fundingNormalized,
      zScore,
      spreadAgeMin: age != null ? Math.round(age) : null,
      score: sc.score,
      scoreParts: sc.parts,
      fundingAbs,
      oiUsdMax,
      dOiPct15m: dOi15,
      dOiPct1h: dOi1h,
      natrPctMax: natrMax,
      volZMax: volZMax,
      sweepFresh: sweepBest,
      cvdTaker: cvd,
      spark,
      spreadSpark,
      tradingViewSymbol: `BINANCE:${a.symbol}.P`,
      spotBasisPct,
      spotBasis,
      fundingSpreadPct,
      fundingNextMin,
      fundingNextFrom,
      cvdProxy: cvdProxyV,
      btcCorr: corrV,
      whaleNetUsd: wh?.netUsd ?? null,
      whaleCount: wh?.count ?? null,
      rep: repEntry,
      breakout: breakoutV,
      chop: chopV,
      dist: distV,
      illiqProxy: illiqProxyV,
      algoProxy: algoProxyV,
      liq5mUsd: null,
      liq15mUsd: null,
      liqLongUsd: null,
      liqShortUsd: null,
      lsrLongPct: null,
      lsrRatio: null,
      lsrEx: null,
      deep: null,
    });

    // журнал: порог + cooldown
    if (netSpreadPct != null && netSpreadPct >= JOURNAL_THRESHOLD && bestBid && bestAsk) {
      if (seriesStore.getLastSignalTs(a.symbol) < now - JOURNAL_COOLDOWN) {
        seriesStore.markJournaled(a.symbol, now);
        appendJournal({
          ts: now,
          symbol: a.symbol,
          spreadPct: Number(netSpreadPct.toFixed(3)),
          netPct: Number(netSpreadPct.toFixed(3)),
          zScore: zScore != null ? Number(zScore.toFixed(2)) : null,
          score: sc.score,
          refExchange: refEx,
          hiExchange: bestBid.exchange,
          loExchange: bestAsk.exchange,
        });
        /* История паттернов: спред. Запись ОТЛОЖЕНА до конца deep-блока — там и
           только там известен слипейдж стакана, а без него исход считается с одними
           комиссиями (0.179% против 1.04% слипейджа круга на живом замере), и вердикт
           по эджу выходит положительным за счёт пропущенного члена. Порог и кулдаун
           отрабатывают здесь, как и раньше: популяция сигналов не меняется, меняется
           только момент записи внутри одного и того же скана. */
        const hiAgg = a.per.get(bestBid.exchange);
        const loAgg = a.per.get(bestAsk.exchange);
        deferredSpreadSignals.push({
          ts: now,
          symbol: a.symbol,
          pattern: 'spread',
          dir: 'arb',
          price,
          ex: loAgg ? bestAsk.exchange : null,
          native: loAgg?.native ?? null,
          netPct: Number(netSpreadPct.toFixed(3)),
          zScore: zScore != null ? Number(zScore.toFixed(2)) : null,
          score: sc.score,
          hiEx: bestBid.exchange,
          loEx: bestAsk.exchange,
          hiNative: hiAgg?.native,
          loNative: loAgg?.native,
          hiPrice: bestBid.price,
          loPrice: bestAsk.price,
          spreadPct: crossSpreadPct != null ? Number(crossSpreadPct.toFixed(3)) : undefined,
        });
      }
    }

    // история паттернов: свип / киты / фандинг
    const bestP = [...a.per.entries()].sort((x, y) => y[1].turnover - x[1].turnover)[0];
    if (sweepBest && sweepBest.ageMin <= RECORD_THR.sweepMaxAgeMin && (volZMax ?? 0) >= RECORD_THR.sweepMinVolZ) {
      appendPattern({
        ts: now,
        symbol: a.symbol,
        pattern: 'sweep',
        dir: sweepBest.dir === 'up' ? 'short' : 'long', // сняли сверху → откат вниз
        price,
        ex: bestP[0],
        native: bestP[1].native,
        score: sc.score,
        wickAtr: sweepBest.wickAtr,
        volMult: sweepBest.volMult,
        netPct: netSpreadPct != null ? Number(netSpreadPct.toFixed(3)) : null,
      });
    }
    if (wh && Math.abs(wh.netUsd) >= RECORD_THR.whaleNetUsd) {
      appendPattern({
        ts: now,
        symbol: a.symbol,
        pattern: 'whale',
        dir: wh.netUsd > 0 ? 'long' : 'short',
        price,
        ex: bestP[0],
        native: bestP[1].native,
        score: sc.score,
        whaleUsd: Math.round(wh.netUsd),
      });
    }
    if (fundingAbs != null && fundingAbs >= RECORD_THR.fundingAbs && fundingVals.length) {
      const signedFund = fundingVals.reduce((x, y) => (Math.abs(y) > Math.abs(x) ? y : x), 0);
      appendPattern({
        ts: now,
        symbol: a.symbol,
        pattern: 'funding',
        dir: signedFund > 0 ? 'short' : 'long', // против перегретой стороны
        price,
        ex: bestP[0],
        native: bestP[1].native,
        score: sc.score,
        fundingPct: Number((signedFund * 100).toFixed(4)),
      });
    }
  }

  // монеты, выпавшие из топа, больше не наблюдаются — снимаем их метки возраста сигнала
  seriesStore.dropSignalAgesExcept(new Set(rows.map((r) => r.symbol)));

  /* 5a. НЕЛИКВИД: deep-блок (стакан + лента).
     Отбор только по скору оставлял самые неликвидные монеты вовсе без стакана: скор
     неликвидность не учитывает, а без книги у монеты нет ни слипейджа, ни maxPos, ни
     ленты — то есть ровно тех величин, ради которых неликвид и смотрят. Поэтому часть
     мест резервируется под верх по illiqProxy. */
  const aggBySym = new Map(ranked.map((x) => [x.a.symbol, x.a]));
  const deepTargets = [...rows].sort((x, y) => y.score - x.score).slice(0, DEEP_TARGETS - DEEP_ILLIQ_QUOTA);
  const deepChosen = new Set(deepTargets.map((r) => r.symbol));
  for (const r of [...rows].sort((x, y) => (y.illiqProxy ?? 0) - (x.illiqProxy ?? 0))) {
    if (deepTargets.length >= DEEP_TARGETS) break;
    if (deepChosen.has(r.symbol)) continue;
    deepChosen.add(r.symbol);
    deepTargets.push(r);
  }
  await pMap(
    deepTargets,
    async (r) => {
      if (deepBudgetLeft() <= 0) {
        skippedStages.add('стакан и лента');
        return;
      }
      const a = aggBySym.get(r.symbol);
      if (!a) return;
      const entryExId = r.bestAsk && a.per.has(r.bestAsk.exchange) ? r.bestAsk.exchange : null;
      const exitExId = r.bestBid && a.per.has(r.bestBid.exchange) ? r.bestBid.exchange : null;
      // native-символы берём из agg-карты (bestAsk/bestBid хранят только exchange+price)
      const exList: Array<{ ex: ExchangeId; native: string }> = [];
      if (entryExId) exList.push({ ex: entryExId, native: a.per.get(entryExId)!.native });
      if (exitExId && exitExId !== entryExId) exList.push({ ex: exitExId, native: a.per.get(exitExId)!.native });
      if (!exList.length) return;
      const depths: Partial<Record<ExchangeId, ExDepth>> = {};
      await Promise.all(
        exList.map(async ({ ex, native }) => {
          const book = await mapLimitKey(`book:${ex}:${native}`, cache.books, 180_000, () => fetchOrderbook(ex, native));
          pruneMap(cache.books);
          const d = book ? analyzeBook(book) : null;
          if (d) depths[ex] = d;
        })
      );
      const tapeEx = entryExId ?? exList[0].ex;
      const tapeNative = a.per.get(tapeEx)?.native ?? exList[0].native;
      const rawTape = await mapLimitKey(`tape:${tapeEx}:${tapeNative}`, cache.tapes, 120_000, () => fetchTape(tapeEx, tapeNative));
      pruneMap(cache.tapes);
      const tape = rawTape ? analyzeTape(rawTape) : null;
      r.deep = assembleDeep({
        entryEx: entryExId,
        exitEx: exitExId,
        depths,
        tape,
        tapeEx: tape ? tapeEx : null,
        amihud: amihudBySym.get(r.symbol) ?? null,
        volZ: r.volZMax,
        dOiPct15m: r.dOiPct15m,
        sweepAgeMin: r.sweepFresh?.ageMin ?? null,
        netSpreadPct: r.netSpreadPct,
        crossSpreadPct: r.crossSpreadPct,
        turnoverUsd: r.turnoverUsd,
        /* Волатильность берётся с той же биржи, где считается маркет-мейкинг (там же лента),
           а не максимум по монете: чужая свеча описывает чужую книгу. */
        natrPct: r.exchanges.find((e) => e.exchange === tapeEx)?.natrPct ?? r.natrPctMax,
        natrIntervalMin: tapeEx === 'bitget' ? 3 : 1,
      });

      /* Пересчёт скора по стакану: до этого момента мультибиржевой блок считал спред
         по топу книги, как будто он исполним любым размером. Теперь у монеты есть
         реальные слипейдж и max-позиция — спред засчитывается по исполнимой части. */
      r.netExecPct = execSpreadPct(r.netSpreadPct, r.deep.slipRoundTripPct);
      if (r.deep.slipRoundTripPct != null || r.deep.maxPosUsd != null) {
        const sc2 = computeScore({
          natrPct: r.natrPctMax,
          dOiPct15m: r.dOiPct15m,
          dOiPct1h: r.dOiPct1h,
          sweep: r.sweepFresh,
          volZ: r.volZMax,
          netSpreadPct: r.netSpreadPct,
          zScore: r.zScore,
          coverage: r.coverage,
          fundingAbs: r.fundingAbs,
          slipRoundTripPct: r.deep.slipRoundTripPct,
          maxPosUsd: r.deep.maxPosUsd,
        });
        r.score = sc2.score;
        r.scoreParts = sc2.parts;
      }
      // история паттернов: «робот вошёл в неликвид» (исход — ход в сторону агрессии)
      if (r.deep.pattern?.robotIlliquid) {
        const bestP = [...a.per.entries()].sort((x, y) => y[1].turnover - x[1].turnover)[0];
        appendPattern({
          ts: now,
          symbol: r.symbol,
          pattern: 'robot',
          dir: r.deep.tape && r.deep.tape.aggression < 0 ? 'short' : 'long',
          price: r.price,
          ex: bestP[0],
          native: bestP[1].native,
          netPct: r.netSpreadPct != null ? Number(r.netSpreadPct.toFixed(3)) : null,
          score: r.score,
          algoScore: r.deep.algoScore,
          illiqScore: r.deep.illiqScore,
          aggression: r.deep.tape?.aggression ?? undefined,
        });
      }
    },
    4
  );

  /* 5a-ante. Отложенные спред-сигналы: пишутся здесь, потому что слипейдж стакана
     известен только после deep-блока. Монеты вне deep-топа получают slipRoundTripPct
     = null — это честное «не измерено», и исход по ним пометится costSlipModeled:
     false, а не посчитается так, будто слипейджа нет. */
  for (const sig of deferredSpreadSignals) {
    const row = rows.find((r) => r.symbol === sig.symbol);
    appendPattern({ ...sig, slipRoundTripPct: row?.deep?.slipRoundTripPct ?? null });
  }

  /* 5a-bis. Бумажные сделки — сразу после deep-блока: только здесь у монеты уже известны
     слипейдж и исполнимый спред, а без них симулятор торговал бы спредом с верха книги. */
  try {
    const ap = autoPaper(rows);
    if (ap.opened || ap.closed.tp || ap.closed.sl || ap.closed.timeout || ap.closed.converged) {
      console.log(
        `[paper] открыто ${ap.opened}, закрыто: TP ${ap.closed.tp} / SL ${ap.closed.sl} / сошлось без прибыли ${ap.closed.converged} / таймаут ${ap.closed.timeout}`
      );
    }
  } catch (e) {
    // симулятор не должен ронять скан
    console.error('[paper]', e instanceof Error ? e.message : e);
  }

  // 5b. ЛИКВИДАЦИИ + LONG/SHORT RATIO розницы (топ-40 по скору; OKX-ликвидации, Bybit/OKX-LSR)
  const liqTargets = [...rows].sort((x, y) => y.score - x.score).slice(0, 40);
  await pMap(
    liqTargets,
    async (r) => {
      if (budgetLeft() <= 0) {
        skippedStages.add('ликвидации и Л/Ш');
        return;
      }
      const a = aggBySym.get(r.symbol);
      if (!a) return;
      const okxP = a.per.get('okx');
      const bybitP = a.per.get('bybit');
      const jobs: Promise<void>[] = [];
      if (okxP) {
        jobs.push(
          mapLimitKey(`liq:${okxP.native}`, cache.liq, 60_000, () => fetchOkxLiquidations(okxP.native, `${okxP.native.split('-')[0]}-USDT`, okxP.price))
            .then((v) => {
              if (v) {
                r.liq5mUsd = v.liq5mUsd;
                r.liq15mUsd = v.liq15mUsd;
                r.liqLongUsd = v.longUsd;
                r.liqShortUsd = v.shortUsd;
              }
            })
        );
      }
      jobs.push(
        (async () => {
          const ccy = r.symbol.replace(/USDT$/, '');
          const order: ExchangeId[] = bybitP ? ['bybit', 'okx'] : ['okx', 'bybit'];
          for (const ex of order) {
            const p = a.per.get(ex);
            if (!p) continue;
            const info = await mapLimitKey(`lsr:${ex}:${ccy}`, cache.lsr, 300_000, () => fetchLsr(ex, ccy, p.native));
            if (info) {
              r.lsrLongPct = Number(info.longPct.toFixed(1));
              r.lsrRatio = info.ratio != null ? Number(info.ratio.toFixed(2)) : null;
              r.lsrEx = info.src;
              return;
            }
          }
        })()
      );
      await Promise.all(jobs);
    },
    6
  );

  /* 5b-bis. СЕТАПЫ ДВИЖЕНИЯ: пересчёт с лентой, ликвидациями и позицией розницы,
     затем запись в историю паттернов. Раньше этого места нельзя: тейкерская агрессия
     приходит только с deep-блоком (5a), а ликвидации и L/S — из 5b. Пишем в историю
     только то, что является прогнозом: пробой ДО выхода за уровень, раздачу с
     подтверждённым расхождением потока и цены, ёрш как предупреждение о ложных пробоях. */
  for (const r of rows) {
    const kl = bestKlBySym.get(r.symbol);
    if (!kl) continue;
    const a = aggBySym.get(r.symbol);
    const tape = r.deep?.tape ?? null;
    const flow = r.cvdTaker ?? r.cvdProxy;

    if (tape) {
      const chop2 = detectChop(kl.candles, tape);
      if (chop2) r.chop = chop2;
    }
    // фандинг со знаком, приведённый к 8ч: у раздачи важно, какая сторона платит
    const fundSigned = r.exchanges
      .map((x) => normalizeFunding(x.fundingRate, x.fundingIntervalMin))
      .filter((v): v is number => v != null)
      .reduce<number | null>((acc, v) => (acc == null || Math.abs(v) > Math.abs(acc) ? v : acc), null);
    r.dist = detectDistribution(kl.candles, {
      natrPct: r.natrPctMax,
      dOiPct15m: r.dOiPct15m,
      cvd: flow,
      tape,
      whaleNetUsd: r.whaleNetUsd,
      lsrLongPct: r.lsrLongPct,
      fundingSigned: fundSigned,
      liqLongUsd: r.liqLongUsd,
      liqShortUsd: r.liqShortUsd,
    });
    if (tape) {
      r.breakout = detectBreakout(kl.candles, {
        volZ: r.volZMax,
        dOiPct15m: r.dOiPct15m,
        cvd: flow,
        chopScore: r.chop?.score ?? 0,
      });
    }

    if (!a) continue;
    const bestP = [...a.per.entries()].sort((x, y) => y[1].turnover - x[1].turnover)[0];

    if (r.breakout && r.breakout.ready && r.breakout.score >= BREAKOUT_ALERT) {
      appendPattern({
        ts: now,
        symbol: r.symbol,
        pattern: 'breakout',
        dir: r.breakout.dir === 'up' ? 'long' : 'short',
        price: r.price,
        ex: bestP[0],
        native: bestP[1].native,
        score: r.score,
        setupScore: r.breakout.score,
        level: r.breakout.level,
        distAtr: r.breakout.distAtr,
        chopScore: r.chop?.score ?? null,
        natrPct: r.natrPctMax,
      });
    }
    if (r.dist && r.dist.dir) {
      appendPattern({
        ts: now,
        symbol: r.symbol,
        pattern: 'distribution',
        dir: r.dist.dir,
        price: r.price,
        ex: bestP[0],
        native: bestP[1].native,
        score: r.score,
        setupScore: r.dist.score,
        distKind: r.dist.kind,
        movePct: r.dist.movePct,
      });
    }
    if (r.chop?.isErsh) {
      appendPattern({
        ts: now,
        symbol: r.symbol,
        pattern: 'chop',
        dir: 'arb', // предупреждение, а не сделка: исход — удержался ли диапазон
        price: r.price,
        ex: bestP[0],
        native: bestP[1].native,
        score: r.score,
        setupScore: r.chop.score,
        erThr: CHOP_ER_MAX,
      });
    }
  }

  // 5c. Снапшот для бэктеста фильтров (только свежий скан)
  appendSnapshot(
    rows
      .filter((r) => r.bestBid && r.bestAsk && r.bestBid.exchange !== r.bestAsk.exchange)
      .map((r) => ({
        s: r.symbol,
        net: r.netSpreadPct ?? 0,
        hi: r.bestBid!.exchange,
        lo: r.bestAsk!.exchange,
        pBuy: r.bestBid!.price,
        pSell: r.bestAsk!.price,
        sc: r.score,
        // слипейдж одного пересечения книг — чтобы бэктест считал круг, а не разность
        slip: r.deep?.slipRoundTripPct ?? undefined,
      }))
  );

  // 6. Рыночный пульс + статусы бирж
  const market = await getMarketPulse();
  // фоновая дооценка исходов паттернов (батч ≤10 за вызов, не блокирует скан)
  void resolvePending().catch(() => undefined);
  // прогрев-персистентность: раз в ~90с пишем серии на диск
  scheduleSeriesPersist();
  const statuses: ExchangeStatus[] = EXCHANGES.map((e) => {
    const r = tickers[e.id];
    // возраст считаем от текущего момента: `now` снят до фетчей, из-за чего
    // ageSec выходил отрицательным и флаг stale не срабатывал никогда
    const ageSec = r ? Math.max(0, Math.round((Date.now() - r.fetchedAt) / 1000)) : 0;
    return {
      exchange: e.id,
      ok: !!r?.ok,
      error: r?.error,
      symbols: r?.tickers.length || 0,
      fetchedAt: r?.fetchedAt || 0,
      ageSec,
      stale: !!r?.ok && ageSec > 120,
      note: e.id === 'mexc' && r?.error ? 'IP сервера в блок-листе; включится автоматически при смене IP' : e.id === 'ourbit' && r?.error ? 'нет публичного API; заготовка готова' : undefined,
    };
  });

  const errors: Record<string, string> = {};
  for (const s of statuses) if (!s.ok && s.error) errors[s.exchange] = s.error;

  return {
    ts: now,
    cached: false,
    top: ranked.length,
    klinedSymbols: klinesBy.size,
    rows,
    assetClass,
    // скачок этого числа = биржа изменила состав инструментов
    excludedByClass,
    excludedAsNonPerp,
    skippedStages: [...skippedStages],
    statuses,
    errors,
    refExchange: refExchangePref === 'auto' ? 'auto' : refExchangePref,
    alertThresholdPct: 0.3,
    journal: journalSummary(),
    market,
  };
}

/* Кэш сканов: ключ = top + полоса оборота. refExchange в ключ НЕ входит — он влияет лишь
   на refSpreadPct, а вызовы идут с разными значениями (главная — с выбранной биржей,
   radar/liquidity/ai-comment — с 'auto'), и ключ с ним заставлял бы их вытеснять друг друга,
   гоняя полный doScan на каждый запрос и дублируя снапшоты с записями журнала.
   Полоса в ключе обязательна: это разные наборы монет, и один не является кэшем другого. */
const SCAN_CACHE_MAX = 4;

function scanKey(top: number, uni: Universe, assetClass: AssetClassFilter): string {
  // sampling и класс входят в ключ: при одной и той же полосе это разные наборы монет
  return `${top}|${uni.minTurnoverUsd}|${uni.maxTurnoverUsd}|${uni.sampling ?? 'top'}|${assetClass}`;
}

export async function getScan(
  top = TOP_DEFAULT,
  refExchange: ExchangeId | 'auto' = 'auto',
  uni: Universe = UNIVERSE_ALL,
  assetClass: AssetClassFilter = 'crypto'
): Promise<ScanResponse> {
  if (!(cache.scans instanceof Map)) cache.scans = new Map();
  const key = scanKey(top, uni, assetClass);
  const hit = cache.scans.get(key);
  if (hit && Date.now() - hit.ts < SCAN_TTL) {
    // ярлык не переклеиваем: в ответе остаётся та биржа, против которой строки реально посчитаны
    return { ...hit.resp, cached: true };
  }
  /* Скан по этому ключу уже идёт — ждём его вместо второго круга запросов к биржам */
  if (!(cache.inflight instanceof Map)) cache.inflight = new Map();
  const pending = cache.inflight.get(key);
  if (pending) return pending;

  const p = doScan(top, refExchange, uni, assetClass)
    .then((resp) => {
      /* Скан, в котором не ответила НИ ОДНА биржа, кэшировать нельзя: один сетевой
         сбой иначе гасит скринер на весь TTL — пустой ответ отдаётся всем 45 секунд,
         сигналы в это время не рождаются, а серии рвутся, и потом нечем дооценить
         исходы. Такой ответ не кэшируем, а отдаём последний удачный (с его собственным
         ts и флагом cached, по которым видно, что данные не свежие). */
      const anyOk = (resp.statuses ?? []).some((s) => s?.ok);
      if (!anyOk) {
        const prev = cache.scans.get(key);
        if (prev) return { ...prev.resp, cached: true };
        return resp;
      }
      cache.scans.set(key, { ts: Date.now(), resp });
      // вытесняем самый старый: полос немного, но список не должен расти без границы
      if (cache.scans.size > SCAN_CACHE_MAX) {
        const oldest = [...cache.scans.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) cache.scans.delete(oldest[0]);
      }
      return resp;
    })
    .finally(() => {
      cache.inflight.delete(key);
    });
  cache.inflight.set(key, p);
  return p;
}

