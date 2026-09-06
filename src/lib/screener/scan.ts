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
import { fetchKlines, fetchTickers, pMap, fetchBingxPremium, fetchBingxOI, fetchBingxTaker, fetchOkxFunding, fetchOkxOI, fetchBitgetOI, fetchSpotPrices, fetchWhaleTrades, fetchOrderbook, fetchTape, fetchOkxLiquidations, fetchLsr, type Book, type SpotMap, type TapeTrade, type WhaleInfo, type LiqInfo, type LsrInfo } from './exchanges';
import { computeScore, detectSweep, execSpreadPct, natrPct, volumeZ, cvdProxy, btcCorr } from './score';
import { amihudPct, algoProxyOf, analyzeBook, analyzeTape, assembleDeep, illiqProxyOf } from './liquidity';
import { seriesStore, appendJournal, journalSummary, appendSnapshot, symbolReputation, warmupSeries, scheduleSeriesPersist } from './store';
import { appendPattern, resolvePending } from './patterns';
import { getMarketPulse } from './market';

const TOP_DEFAULT = 80;
const KLINED_SYMBOLS = 80;
const SCAN_TTL = 45_000;
const TICKERS_TTL = 30_000;
const KLINES_TTL = 45_000;
const OI_TTL = 180_000;
const FUNDING_TTL = 300_000;
const OI_HISTORY_TTL = 300_000;
const JOURNAL_THRESHOLD = 0.25; // % — порог для записи в журнал
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
    scan: { ts: number; top: number; resp: ScanResponse } | null;
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
  };
}
const cache = g.__screenerScan;
/* защитная инициализация: globalThis переживает HMR — старый объект может не иметь новых полей */
if (!cache.prem) cache.prem = new Map();
if (!cache.whale) cache.whale = new Map();
if (!cache.books) cache.books = new Map();
if (!cache.tapes) cache.tapes = new Map();
if (!cache.liq) cache.liq = new Map();
if (!cache.lsr) cache.lsr = new Map();
if (cache.spot === undefined) cache.spot = null;
if (cache.oi === undefined) cache.oi = new Map();
if (cache.funding === undefined) cache.funding = new Map();
if (cache.klines === undefined) cache.klines = new Map();
if (cache.oiHistory === undefined) cache.oiHistory = new Map();

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

async function doScan(top: number, refExchangePref: ExchangeId | 'auto'): Promise<ScanResponse> {
  warmupSeries(); // прогрев: восстановить серии с диска до первых записей
  const now = Date.now();
  const tickers = await getTickers();
  const okExchanges = EXCHANGES.filter((e) => tickers[e.id]?.ok);

  // 1. Объединение тикеров по нормализованному символу
  interface Agg {
    symbol: string;
    per: Map<ExchangeId, { native: string; price: number; turnover: number; funding: number | null; oi: number | null; oiUsd: number | null; nfTs: number | null }>;
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
        turnover: t.turnoverUsd,
        funding: t.fundingRate ?? null,
        oi: t.oi ?? null,
        oiUsd: t.oiUsd ?? null,
        nfTs: t.nextFundingTs ?? null,
      });
    }
  }

  // 2. Топ по максимальному обороту
  const ranked = [...agg.values()]
    .map((a) => ({ a, maxTurnover: Math.max(...[...a.per.values()].map((p) => p.turnover)) }))
    .sort((x, y) => y.maxTurnover - x.maxTurnover)
    .slice(0, top);

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
      const p = a.per.get('bybit');
      if (!p) return;
      whaleMap.set(a.symbol, await getWhale(p.native));
    },
    6
  );

  // 5. Построение строк
  const feeById = Object.fromEntries(EXCHANGES.map((e) => [e.id, e.takerFee])) as Record<ExchangeId, number>;
  const rows: CoinRow[] = [];
  const amihudBySym = new Map<string, number | null>();

  for (const { a } of ranked) {
    const prices = [...a.per.values()].map((p) => p.price).sort((x, y) => x - y);
    const price = prices[Math.floor(prices.length / 2)];
    const hi = prices[prices.length - 1];
    const lo = prices[0];
    const mid = (hi + lo) / 2;
    const crossSpreadPct = hi > 0 ? ((hi - lo) / ((hi + lo) / 2)) * 100 : null;

    // эталонная биржа
    let refEx: ExchangeId;
    if (refExchangePref !== 'auto' && a.per.has(refExchangePref)) refEx = refExchangePref;
    else {
      refEx = [...a.per.entries()].sort((x, y) => y[1].turnover - x[1].turnover)[0][0];
    }
    const refPrice = a.per.get(refEx)!.price;
    const refSpreadPct =
      refPrice > 0 ? (Math.max(Math.abs(hi - refPrice), Math.abs(lo - refPrice)) / refPrice) * 100 : null;

    // нетто-спред: лучшие bid/ask между биржами
    let bestBid: { exchange: ExchangeId; price: number } | undefined;
    let bestAsk: { exchange: ExchangeId; price: number } | undefined;
    for (const [exId, p] of a.per) {
      if (!bestBid || p.price > bestBid.price) bestBid = { exchange: exId, price: p.price };
      if (!bestAsk || p.price < bestAsk.price) bestAsk = { exchange: exId, price: p.price };
    }
    let netSpreadPct: number | null = null;
    if (bestBid && bestAsk && bestBid.exchange !== bestAsk.exchange) {
      const gross = ((bestBid.price - bestAsk.price) / bestAsk.price) * 100;
      const fees = (feeById[bestBid.exchange] + feeById[bestAsk.exchange]) * 100;
      netSpreadPct = gross - fees;
    }

    // серии в стор
    for (const [exId, p] of a.per) {
      seriesStore.addPrice(a.symbol, exId, now, p.price);
      if (p.oi != null) seriesStore.addOi(a.symbol, exId, now, p.oi);
      if (p.funding != null) seriesStore.addFunding(a.symbol, exId, now, p.funding);
      const ext = extras.get(a.symbol)?.get(exId);
      if (ext?.oi != null) seriesStore.addOi(a.symbol, exId, now, ext.oi);
      if (ext?.funding != null) seriesStore.addFunding(a.symbol, exId, now, ext.funding);
    }
    if (crossSpreadPct != null) seriesStore.addCrossSpread(a.symbol, now, crossSpreadPct);

    // z-score и возраст сигнала
    const zScore = crossSpreadPct != null ? seriesStore.spreadZScore(a.symbol, crossSpreadPct) : null;

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
        fundingRate: p.funding ?? ext?.funding ?? null,
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

    const fundingVals = exRows.map((r) => r.fundingRate).filter((v): v is number => v != null);
    const fundingAbs = fundingVals.length ? Math.max(...fundingVals.map(Math.abs)) : null;
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
    // разброс фандинга между биржами
    const fundRatesAll = exRows.map((r) => r.fundingRate).filter((v): v is number => v != null);
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

    seriesStore.trackSignalAge(a.symbol, now, JOURNAL_THRESHOLD, netSpreadPct);
    const age = seriesStore.signalAge(a.symbol, now);

    rows.push({
      symbol: a.symbol,
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
        // история паттернов: спред (исход — схлопывание вдвое по кросс-спреду)
        const hiAgg = a.per.get(bestBid.exchange);
        const loAgg = a.per.get(bestAsk.exchange);
        appendPattern({
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
    if (sweepBest && sweepBest.ageMin <= 5 && (volZMax ?? 0) >= 1.5) {
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
    if (wh && Math.abs(wh.netUsd) >= 300_000) {
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
    if (fundingAbs != null && fundingAbs >= 0.001 && fundingVals.length) {
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

  // 5a. НЕЛИКВИД: deep-блок (стакан + лента) для топ-40 по скору
  const aggBySym = new Map(ranked.map((x) => [x.a.symbol, x.a]));
  const deepTargets = [...rows].sort((x, y) => y.score - x.score).slice(0, 40);
  await pMap(
    deepTargets,
    async (r) => {
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

  // 5b. ЛИКВИДАЦИИ + LONG/SHORT RATIO розницы (топ-40 по скору; OKX-ликвидации, Bybit/OKX-LSR)
  const liqTargets = [...rows].sort((x, y) => y.score - x.score).slice(0, 40);
  await pMap(
    liqTargets,
    async (r) => {
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
    const ageSec = r ? Math.round((now - r.fetchedAt) / 1000) : 0;
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
    statuses,
    errors,
    refExchange: refExchangePref === 'auto' ? 'auto' : refExchangePref,
    alertThresholdPct: 0.3,
    journal: journalSummary(),
    market,
  };
}

export async function getScan(top = TOP_DEFAULT, refExchange: ExchangeId | 'auto' = 'auto'): Promise<ScanResponse> {
  const hit = cache.scan;
  // Ключ кэша — только top. refExchange влияет лишь на refSpreadPct, а вызовы идут с разными
  // значениями (главная — с выбранной биржей, radar/liquidity/ai-comment — с 'auto'), поэтому
  // ключ с refExchange заставлял бы их вытеснять друг друга и гонять полный doScan на каждый
  // запрос, попутно дублируя снапшоты и записи журнала.
  if (hit && Date.now() - hit.ts < SCAN_TTL && hit.top === top) {
    // ярлык не переклеиваем: в ответе остаётся та биржа, против которой строки реально посчитаны
    return { ...hit.resp, cached: true };
  }
  const resp = await doScan(top, refExchange);
  cache.scan = { ts: Date.now(), top, resp };
  return resp;
}

