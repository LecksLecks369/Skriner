import type { Candle, ExchangeFetchResult, ExchangeId, KlinesResult, RawTicker } from './types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchJson<T>(url: string, timeoutMs = 9000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
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

/** Число из поля тикера; null, если поля нет или оно не положительное */
function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return isFinite(n) && n > 0 ? n : null;
}

export function normalizeSymbol(ex: ExchangeId, native: string): string {
  if (ex === 'bybit' || ex === 'bitget') return native; // BTCUSDT
  if (ex === 'bingx') return native.replace('-', ''); // BTC-USDT -> BTCUSDT
  if (ex === 'okx') return native.replace(/-SWAP$/, '').replace('-', ''); // BTC-USDT-SWAP
  if (ex === 'mexc') return native.replace('_', ''); // BTC_USDT -> BTCUSDT
  return native;
}

/* ---------------- BYBIT ---------------- */
async function fetchBybit(): Promise<ExchangeFetchResult> {
  const t0 = Date.now();
  const j = await fetchJson<{
    retCode: number;
    result?: { list?: Array<Record<string, string>> };
  }>('https://api.bybit.com/v5/market/tickers?category=linear');
  if (j.retCode !== 0 || !j.result?.list) throw new Error('bybit retCode!=0');
  const tickers: RawTicker[] = [];
  for (const t of j.result.list) {
    const price = parseFloat(t.lastPrice);
    const turnover = parseFloat(t.turnover24h || '0');
    if (!price || price <= 0) continue;
    tickers.push({
      symbol: normalizeSymbol('bybit', t.symbol),
      nativeSymbol: t.symbol,
      price,
      bid: numOrNull(t.bid1Price),
      ask: numOrNull(t.ask1Price),
      turnoverUsd: turnover,
      fundingRate: t.fundingRate ? parseFloat(t.fundingRate) : null,
      oi: t.openInterest ? parseFloat(t.openInterest) : null,
      oiUsd: t.openInterestValue ? parseFloat(t.openInterestValue) : null,
      nextFundingTs: t.nextFundingTime ? Number(t.nextFundingTime) : null,
    });
  }
  return { exchange: 'bybit', ok: true, tickers, fetchedAt: Date.now(), lagMs: Date.now() - t0 };
}

async function fetchBybitKlines(native: string, limit = 90): Promise<Candle[]> {
  const j = await fetchJson<{ retCode: number; result?: { list?: string[][] } }>(
    `https://api.bybit.com/v5/market/kline?category=linear&symbol=${native}&interval=1&limit=${limit}`
  );
  const list = j.result?.list || [];
  // новые первыми -> разворачиваем
  return list
    .map((r) => ({
      ts: Number(r[0]),
      o: parseFloat(r[1]),
      h: parseFloat(r[2]),
      l: parseFloat(r[3]),
      c: parseFloat(r[4]),
      v: parseFloat(r[5]),
      qv: parseFloat(r[6]),
    }))
    .filter((c) => c.c > 0)
    .reverse();
}

/* ---------------- BINGX ---------------- */
async function fetchBingx(): Promise<ExchangeFetchResult> {
  const t0 = Date.now();
  const j = await fetchJson<{ code: number; data?: Array<Record<string, string>> }>(
    'https://open-api.bingx.com/openApi/swap/v2/quote/ticker'
  );
  if (j.code !== 0 || !j.data) throw new Error('bingx code!=0');
  const tickers: RawTicker[] = [];
  for (const t of j.data) {
    const price = parseFloat(t.lastPrice);
    const turnover = parseFloat(t.quoteVolume || '0');
    if (!price || price <= 0) continue;
    tickers.push({
      symbol: normalizeSymbol('bingx', t.symbol),
      nativeSymbol: t.symbol,
      price,
      bid: numOrNull(t.bidPrice),
      ask: numOrNull(t.askPrice),
      turnoverUsd: turnover,
      fundingRate: null,
      oi: null,
      oiUsd: null,
    });
  }
  return { exchange: 'bingx', ok: true, tickers, fetchedAt: Date.now(), lagMs: Date.now() - t0 };
}

async function fetchBingxKlines(native: string, limit = 90): Promise<Candle[]> {
  const j = await fetchJson<{ code: number; data?: Array<Record<string, unknown>> }>(
    `https://open-api.bingx.com/openApi/swap/v2/quote/klines?symbol=${native}&interval=1m&limit=${limit}`
  );
  const list = (j.data || []) as Array<{ time: number; open: string; high: string; low: string; close: string; volume: string; quoteVolume?: string }>;
  return list
    .map((r) => ({
      ts: Number(r.time),
      o: parseFloat(r.open),
      h: parseFloat(r.high),
      l: parseFloat(r.low),
      c: parseFloat(r.close),
      v: parseFloat(r.volume),
      qv: parseFloat(r.quoteVolume || '0'),
    }))
    .filter((c) => c.c > 0);
}

export interface BingxPremium {
  rate: number | null;
  nextTs: number | null;
}

export async function fetchBingxPremium(native: string): Promise<BingxPremium> {
  try {
    const j = await fetchJson<{ code: number; data?: Record<string, string | number> }>(
      `https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex?symbol=${native}`
    );
    const rate = j.data?.lastFundingRate != null ? parseFloat(String(j.data.lastFundingRate)) : null;
    const nextTs = j.data?.nextFundingTime != null ? Number(j.data.nextFundingTime) : null;
    return { rate: isFinite(rate as number) ? (rate as number) : null, nextTs: nextTs && nextTs > 0 ? nextTs : null };
  } catch {
    return { rate: null, nextTs: null };
  }
}

export async function fetchBingxOI(native: string): Promise<number | null> {
  try {
    const j = await fetchJson<{ code: number; data?: Record<string, string> }>(
      `https://open-api.bingx.com/openApi/swap/v2/quote/openInterest?symbol=${native}`
    );
    if (j.data?.openInterest) return parseFloat(j.data.openInterest);
    return null;
  } catch {
    return null;
  }
}

export async function fetchBingxTaker(native: string): Promise<number | null> {
  try {
    const j = await fetchJson<{ code: number; data?: Array<Record<string, string>> }>(
      `https://open-api.bingx.com/openApi/swap/v2/quote/taker-order?symbol=${native}&period=5m&state=1`
    );
    const arr = j.data;
    if (!arr || !arr.length) return null;
    const last = arr[arr.length - 1];
    const vol = parseFloat(last.takerVol || '0');
    const buy = parseFloat(last.takerBuyVol || '0');
    if (!vol) return null;
    return (buy - (vol - buy)) / vol; // -1..1
  } catch {
    return null;
  }
}

/* ---------------- OKX ---------------- */
async function fetchOkx(): Promise<ExchangeFetchResult> {
  const t0 = Date.now();
  const j = await fetchJson<{ code: string; data?: Array<Record<string, string>> }>(
    'https://www.okx.com/api/v5/market/tickers?instType=SWAP'
  );
  if (j.code !== '0' || !j.data) throw new Error('okx code!=0');
  const tickers: RawTicker[] = [];
  for (const t of j.data) {
    if (!t.instId.endsWith('-USDT-SWAP')) continue;
    const price = parseFloat(t.last);
    const baseVol = parseFloat(t.volCcy24h || '0'); // объём в монетах
    if (!price || price <= 0) continue;
    tickers.push({
      symbol: normalizeSymbol('okx', t.instId),
      nativeSymbol: t.instId,
      price,
      bid: numOrNull(t.bidPx),
      ask: numOrNull(t.askPx),
      turnoverUsd: baseVol * price,
      fundingRate: null,
      oi: null,
      oiUsd: null,
    });
  }
  return { exchange: 'okx', ok: true, tickers, fetchedAt: Date.now(), lagMs: Date.now() - t0 };
}

async function fetchOkxKlines(native: string, limit = 90): Promise<Candle[]> {
  const j = await fetchJson<{ code: string; data?: string[][] }>(
    `https://www.okx.com/api/v5/market/candles?instId=${native}&bar=1m&limit=${limit}`
  );
  const list = j.data || [];
  return list
    .map((r) => ({
      ts: Number(r[0]),
      o: parseFloat(r[1]),
      h: parseFloat(r[2]),
      l: parseFloat(r[3]),
      c: parseFloat(r[4]),
      v: parseFloat(r[5]),
      qv: parseFloat(r[6] || '0'),
    }))
    .filter((c) => c.c > 0)
    .reverse();
}

export async function fetchOkxFunding(native: string): Promise<number | null> {
  try {
    const j = await fetchJson<{ code: string; data?: Array<Record<string, string>> }>(
      `https://www.okx.com/api/v5/public/funding-rate?instId=${native}`
    );
    const r = j.data?.[0];
    return r?.fundingRate ? parseFloat(r.fundingRate) : null;
  } catch {
    return null;
  }
}

export async function fetchOkxOI(native: string): Promise<number | null> {
  try {
    const j = await fetchJson<{ code: string; data?: Array<Record<string, string>> }>(
      `https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${native}`
    );
    const r = j.data?.[0];
    return r?.oiCcy ? parseFloat(r.oiCcy) : null;
  } catch {
    return null;
  }
}

/* ---------------- BITGET ---------------- */
async function fetchBitget(): Promise<ExchangeFetchResult> {
  const t0 = Date.now();
  const j = await fetchJson<{ code: string; data?: Array<Record<string, string>> }>(
    'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES'
  );
  if (j.code !== '00000' || !j.data) throw new Error('bitget code!=0');
  const tickers: RawTicker[] = [];
  for (const t of j.data) {
    const price = parseFloat(t.lastPr);
    const turnover = parseFloat(t.usdtVolume || '0');
    if (!price || price <= 0) continue;
    tickers.push({
      symbol: normalizeSymbol('bitget', t.symbol),
      nativeSymbol: t.symbol,
      price,
      bid: numOrNull(t.bidPr),
      ask: numOrNull(t.askPr),
      turnoverUsd: turnover,
      fundingRate: t.fundingRate ? parseFloat(t.fundingRate) : null,
      oi: t.holdingAmount ? parseFloat(t.holdingAmount) : null,
      oiUsd: null,
    });
  }
  return { exchange: 'bitget', ok: true, tickers, fetchedAt: Date.now(), lagMs: Date.now() - t0 };
}

async function fetchBitgetKlines(native: string, limit = 60): Promise<Candle[]> {
  // Bitget: минимум 3m
  const j = await fetchJson<{ code: string; data?: string[][] }>(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${native}&productType=USDT-FUTURES&granularity=3min&limit=${limit}`
  );
  const list = j.data || [];
  return list
    .map((r) => ({
      ts: Number(r[0]),
      o: parseFloat(r[1]),
      h: parseFloat(r[2]),
      l: parseFloat(r[3]),
      c: parseFloat(r[4]),
      v: parseFloat(r[5]),
      qv: parseFloat(r[6] || '0'),
    }))
    .filter((c) => c.c > 0)
    .reverse();
}

export async function fetchBitgetOI(native: string): Promise<number | null> {
  try {
    const j = await fetchJson<{ code: string; data?: { openInterestList?: Array<Record<string, string>> } }>(
      `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${native}&productType=USDT-FUTURES`
    );
    const r = j.data?.openInterestList?.[0];
    return r?.size ? parseFloat(r.size) : null;
  } catch {
    return null;
  }
}

/* ---------------- MEXC (graceful) ---------------- */
const MEXC_BASE = 'https://contract.mexc.com/api/v1/contract';

async function fetchMexc(): Promise<ExchangeFetchResult> {
  const t0 = Date.now();
  const j = await fetchJson<{ success: boolean; data?: Array<Record<string, unknown>> }>(
    `${MEXC_BASE}/detail`
  );
  if (!j.success || !j.data) throw new Error('mexc success!=false');
  const tickers: RawTicker[] = [];
  for (const t of j.data) {
    const symbol = String(t.symbol || '');
    if (!symbol.endsWith('_USDT')) continue;
    if (Number(t.state) !== 0) continue; // 0 = active
    const price = Number(t.lastPrice);
    const turnover = Number(t.turnover24h || 0);
    if (!price || price <= 0) continue;
    tickers.push({
      symbol: normalizeSymbol('mexc', symbol),
      nativeSymbol: symbol,
      price,
      bid: numOrNull(t.bid1),
      ask: numOrNull(t.ask1),
      turnoverUsd: turnover,
      fundingRate: t.fundingRate != null ? Number(t.fundingRate) : null,
      oi: t.holdVol != null ? Number(t.holdVol) : null,
      oiUsd: null,
    });
  }
  return { exchange: 'mexc', ok: true, tickers, fetchedAt: Date.now(), lagMs: Date.now() - t0 };
}

async function fetchMexcKlines(native: string, limit = 90): Promise<Candle[]> {
  const end = Date.now();
  const start = end - 100 * 60 * 1000;
  const j = await fetchJson<{ success: boolean; data?: { time?: number[]; open?: number[]; close?: number[]; high?: number[]; low?: number[]; vol?: number[]; amount?: number[] } }>(
    `${MEXC_BASE}/kline/${native}?interval=Min1&start=${Math.floor(start / 1000)}&end=${Math.floor(end / 1000)}`
  );
  const d = j.data;
  if (!d?.time) return [];
  return d.time
    .map((ts, i) => ({
      ts: ts * 1000,
      o: Number(d.open?.[i] || 0),
      h: Number(d.high?.[i] || 0),
      l: Number(d.low?.[i] || 0),
      c: Number(d.close?.[i] || 0),
      v: Number(d.vol?.[i] || 0),
      qv: Number(d.amount?.[i] || 0),
    }))
    .filter((c) => c.c > 0);
}

/* ---------------- OURBIT (заготовка) ----------------
   Публичный API не индексируется (Cloudflare 403), в ccxt отсутствует.
   Когда появится документация — достаточно вписать URL в константы ниже. */
const OURBIT_TICKER_URL = ''; // напр. https://api.ourbit.com/...
async function fetchOurbit(): Promise<ExchangeFetchResult> {
  if (!OURBIT_TICKER_URL) {
    return {
      exchange: 'ourbit',
      ok: false,
      error: 'нет публичного API (Cloudflare 403); включится автоматически, когда вписан URL',
      tickers: [],
      fetchedAt: Date.now(),
    };
  }
  const t0 = Date.now();
  const j = await fetchJson<{ data?: Array<Record<string, string>> }>(OURBIT_TICKER_URL);
  const tickers: RawTicker[] = [];
  for (const t of j.data || []) {
    const price = parseFloat(t.lastPrice || t.last || '0');
    if (!price) continue;
    tickers.push({
      symbol: normalizeSymbol('ourbit', t.symbol || t.instId || ''),
      nativeSymbol: t.symbol || t.instId || '',
      price,
      bid: numOrNull(t.bidPrice ?? t.bid1 ?? t.bidPx),
      ask: numOrNull(t.askPrice ?? t.ask1 ?? t.askPx),
      turnoverUsd: parseFloat(t.quoteVolume || t.turnover24h || '0'),
      fundingRate: null,
      oi: null,
      oiUsd: null,
    });
  }
  return { exchange: 'ourbit', ok: true, tickers, fetchedAt: Date.now(), lagMs: Date.now() - t0 };
}

/* ---------------- Публичное API ---------------- */
export async function fetchTickers(ex: ExchangeId): Promise<ExchangeFetchResult> {
  try {
    switch (ex) {
      case 'bybit':
        return await fetchBybit();
      case 'bingx':
        return await fetchBingx();
      case 'okx':
        return await fetchOkx();
      case 'bitget':
        return await fetchBitget();
      case 'mexc':
        return await fetchMexc();
      case 'ourbit':
        return await fetchOurbit();
      default:
        throw new Error('unknown exchange');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly =
      msg.includes('HTTP 403')
        ? 'заблокирован с IP сервера (403)'
        : msg.includes('abort') || msg.includes('timeout')
          ? 'таймаут'
          : msg;
    return { exchange: ex, ok: false, error: friendly, tickers: [], fetchedAt: Date.now() };
  }
}

export async function fetchKlines(
  ex: ExchangeId,
  native: string
): Promise<KlinesResult | null> {
  try {
    switch (ex) {
      case 'bybit':
        return { exchange: ex, symbol: native, intervalMin: 1, candles: await fetchBybitKlines(native) };
      case 'bingx':
        return { exchange: ex, symbol: native, intervalMin: 1, candles: await fetchBingxKlines(native) };
      case 'okx':
        return { exchange: ex, symbol: native, intervalMin: 1, candles: await fetchOkxKlines(native) };
      case 'bitget':
        return { exchange: ex, symbol: native, intervalMin: 3, candles: await fetchBitgetKlines(native) };
      case 'mexc':
        return { exchange: ex, symbol: native, intervalMin: 1, candles: await fetchMexcKlines(native) };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** параллельный маппинг с ограничением конкуренции */
export async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 10
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------------- SPOT: цены для спот×перпетуал базиса ---------------- */

async function fetchSpotBybit(): Promise<Map<string, number>> {
  const j = await fetchJson<{ retCode: number; result?: { list?: Array<Record<string, string>> } }>(
    'https://api.bybit.com/v5/market/tickers?category=spot'
  );
  const m = new Map<string, number>();
  for (const t of j.result?.list || []) {
    if (!t.symbol.endsWith('USDT')) continue;
    const p = parseFloat(t.lastPrice);
    if (p > 0) m.set(t.symbol, p);
  }
  return m;
}

async function fetchSpotOkx(): Promise<Map<string, number>> {
  const j = await fetchJson<{ code: string; data?: Array<Record<string, string>> }>(
    'https://www.okx.com/api/v5/market/tickers?instType=SPOT'
  );
  const m = new Map<string, number>();
  for (const t of j.data || []) {
    if (!t.instId.endsWith('-USDT')) continue;
    const p = parseFloat(t.last);
    if (p > 0) m.set(t.instId.replace('-', ''), p);
  }
  return m;
}

async function fetchSpotBitget(): Promise<Map<string, number>> {
  const j = await fetchJson<{ code: string; data?: Array<Record<string, string>> }>(
    'https://api.bitget.com/api/v2/spot/market/tickers'
  );
  const m = new Map<string, number>();
  for (const t of j.data || []) {
    if (!t.symbol.endsWith('USDT')) continue;
    const p = parseFloat(t.lastPr || t.close || '0');
    if (p > 0) m.set(t.symbol, p);
  }
  return m;
}

async function fetchSpotMexc(): Promise<Map<string, number>> {
  const j = await fetchJson<Array<{ symbol: string; price: string }>>(
    'https://api.mexc.com/api/v3/ticker/price'
  );
  const m = new Map<string, number>();
  for (const t of j || []) {
    if (!t.symbol.endsWith('USDT')) continue;
    const p = parseFloat(t.price);
    if (p > 0) m.set(t.symbol, p);
  }
  return m;
}

export type SpotMap = Partial<Record<ExchangeId, Map<string, number>>>;

export async function fetchSpotPrices(): Promise<SpotMap> {
  const out: SpotMap = {};
  const results = await Promise.allSettled([
    fetchSpotBybit(),
    fetchSpotOkx(),
    fetchSpotBitget(),
    fetchSpotMexc(),
  ]);
  const ids: ExchangeId[] = ['bybit', 'okx', 'bitget', 'mexc'];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[ids[i]] = r.value;
  });
  return out;
}

/* ---------------- WHALE: крупные сделки Bybit за последние минуты ---------------- */

export interface WhaleInfo {
  netUsd: number; // buy - sell по китовым сделкам
  count: number;
}

export async function fetchWhaleTrades(
  native: string,
  minUsd = 50_000,
  windowMs = 5 * 60_000
): Promise<WhaleInfo | null> {
  try {
    const j = await fetchJson<{
      retCode: number;
      result?: { list?: Array<{ price: string; size: string; side: string; time: string }> };
    }>(`https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${native}&limit=200`, 8000);
    const list = j.result?.list || [];
    const now = Date.now();
    let buy = 0;
    let sell = 0;
    let count = 0;
    for (const t of list) {
      const ts = Number(t.time);
      if (ts && now - ts > windowMs) continue;
      const usd = parseFloat(t.price) * parseFloat(t.size);
      if (!isFinite(usd) || usd < minUsd) continue;
      count++;
      if (t.side === 'Buy') buy += usd;
      else sell += usd;
    }
    return { netUsd: buy - sell, count };
  } catch {
    return null;
  }
}

/* ---------------- НЕЛИКВИД: L2-стакан ---------------- */

export interface BookLevel {
  p: number;
  s: number;
}
export interface Book {
  bids: BookLevel[]; // по убыванию цены
  asks: BookLevel[]; // по возрастанию цены
}

export async function fetchOrderbook(ex: ExchangeId, native: string): Promise<Book | null> {
  try {
    if (ex === 'bybit') {
      const j = await fetchJson<{ retCode: number; result?: { b?: string[][]; a?: string[][] } }>(
        `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${native}&limit=200`, 7000);
      if (j.retCode !== 0 || !j.result) return null;
      const lv = (arr?: string[][]): BookLevel[] =>
        (arr || []).map((r) => ({ p: parseFloat(r[0]), s: parseFloat(r[1]) })).filter((l) => l.p > 0 && l.s > 0);
      return { bids: lv(j.result.b), asks: lv(j.result.a) };
    }
    if (ex === 'bingx') {
      const j = await fetchJson<{ code: number; data?: { bids?: string[][]; asks?: string[][] } }>(
        `https://open-api.bingx.com/openApi/swap/v2/quote/depth?symbol=${native}&limit=50`, 7000);
      if (j.code !== 0 || !j.data) return null;
      const lv = (arr?: string[][]): BookLevel[] =>
        (arr || []).map((r) => ({ p: parseFloat(r[0]), s: parseFloat(r[1]) })).filter((l) => l.p > 0 && l.s > 0);
      return { bids: lv(j.data.bids), asks: lv(j.data.asks) };
    }
    if (ex === 'okx') {
      const j = await fetchJson<{ code: string; data?: Array<{ bids?: string[][]; asks?: string[][] }> }>(
        `https://www.okx.com/api/v5/market/books?instId=${native}&sz=100`, 7000);
      if (j.code !== '0' || !j.data?.[0]) return null;
      const lv = (arr?: string[][]): BookLevel[] =>
        (arr || []).map((r) => ({ p: parseFloat(r[0]), s: parseFloat(r[1]) })).filter((l) => l.p > 0 && l.s > 0);
      return { bids: lv(j.data[0].bids), asks: lv(j.data[0].asks) };
    }
    if (ex === 'bitget') {
      const j = await fetchJson<{ code: string; data?: { bids?: Array<[number, number]>; asks?: Array<[number, number]> } }>(
        `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${native}&productType=USDT-FUTURES&limit=100`, 7000);
      if (j.code !== '00000' || !j.data) return null;
      const lv = (arr?: Array<[number, number]>): BookLevel[] =>
        (arr || []).map((r) => ({ p: Number(r[0]), s: Number(r[1]) })).filter((l) => l.p > 0 && l.s > 0);
      return { bids: lv(j.data.bids), asks: lv(j.data.asks) };
    }
    return null;
  } catch (e) {
    console.error('[liq-book]', ex, native, e instanceof Error ? e.message : e);
    return null;
  }
}

/* ---------------- НЕЛИКВИД: лента сделок (тейкер-агрессия) ---------------- */

export interface TapeTrade {
  ts: number;
  px: number;
  qty: number; // в монетах
  usd: number;
  taker: 'buy' | 'sell'; // агрессор
}

export async function fetchTape(ex: ExchangeId, native: string): Promise<TapeTrade[] | null> {
  try {
    if (ex === 'bybit') {
      const j = await fetchJson<{ retCode: number; result?: { list?: Array<{ price: string; size: string; side: string; time: string }> } }>(
        `https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${native}&limit=1000`, 8000);
      if (j.retCode !== 0) return null;
      const out = (j.result?.list || [])
        .map((t) => {
          const px = parseFloat(t.price);
          const qty = parseFloat(t.size);
          return { ts: Number(t.time), px, qty, usd: px * qty, taker: (t.side === 'Buy' ? 'buy' : 'sell') as 'buy' | 'sell' };
        })
        .filter((t) => t.px > 0 && t.qty > 0);
      out.sort((a, b) => a.ts - b.ts); // старые первыми
      return out;
    }
    if (ex === 'bingx') {
      const j = await fetchJson<{ code: number; data?: Array<{ time: number; price: string; qty: string; quoteQty?: string; isBuyerMaker: boolean }> }>(
        `https://open-api.bingx.com/openApi/swap/v2/quote/trades?symbol=${native}&limit=100`, 8000);
      if (j.code !== 0) return null;
      const out = (j.data || [])
        .map((t) => {
          const px = parseFloat(t.price);
          const qty = parseFloat(t.qty);
          return { ts: Number(t.time), px, qty, usd: parseFloat(t.quoteQty || String(px * qty)), taker: (t.isBuyerMaker ? 'sell' : 'buy') as 'buy' | 'sell' };
        })
        .filter((t) => t.px > 0 && t.qty > 0);
      out.sort((a, b) => a.ts - b.ts);
      return out;
    }
    if (ex === 'okx') {
      const j = await fetchJson<{ code: string; data?: Array<{ px: string; sz: string; side: string; ts: string }> }>(
        `https://www.okx.com/api/v5/market/trades?instId=${native}&limit=500`, 8000);
      if (j.code !== '0') return null;
      const out = (j.data || [])
        .map((t) => {
          const px = parseFloat(t.px);
          const qty = parseFloat(t.sz);
          return { ts: Number(t.ts), px, qty, usd: px * qty, taker: (t.side === 'buy' ? 'buy' : 'sell') as 'buy' | 'sell' };
        })
        .filter((t) => t.px > 0 && t.qty > 0);
      out.sort((a, b) => a.ts - b.ts);
      return out;
    }
    if (ex === 'bitget') {
      const j = await fetchJson<{ code: string; data?: Array<{ price: string; size: string; side: string; ts: string }> }>(
        `https://api.bitget.com/api/v2/mix/market/fills?symbol=${native}&productType=USDT-FUTURES&limit=500`, 8000);
      if (j.code !== '00000') return null;
      const out = (j.data || [])
        .map((t) => {
          const px = parseFloat(t.price);
          const qty = parseFloat(t.size);
          return { ts: Number(t.ts), px, qty, usd: px * qty, taker: (t.side === 'buy' ? 'buy' : 'sell') as 'buy' | 'sell' };
        })
        .filter((t) => t.px > 0 && t.qty > 0);
      out.sort((a, b) => a.ts - b.ts);
      return out;
    }
    return null;
  } catch (e) {
    console.error('[liq-tape]', ex, native, e instanceof Error ? e.message : e);
    return null;
  }
}

/* ---------------- ЛИКВИДАЦИИ (OKX, публичные filled-каскады) ----------------
   Bybit/Bitget/BingX не отдают ликвидации по REST (Bybit /market/liquidation → 404),
   поэтому источник один — OKX /public/liquidation-orders. sz в контрактах → USD через ctVal. */

export interface LiqInfo {
  liq5mUsd: number;
  liq15mUsd: number;
  longUsd: number; // лонгов вынесено за 15м
  shortUsd: number; // шортов вынесено за 15м
  latestTs: number | null;
}

interface CtValGlobal {
  __okxCtVal: { map: Map<string, number>; ts: number; inflight: Promise<Map<string, number>> | null } | undefined;
}
const cg = globalThis as unknown as CtValGlobal;
if (!cg.__okxCtVal) cg.__okxCtVal = { map: new Map(), ts: 0, inflight: null };
const ctValCache = cg.__okxCtVal;

/** Размер контракта (ctVal) для всех OKX SWAP — один запрос на 6 часов. */
async function getOkxCtVal(): Promise<Map<string, number>> {
  if (ctValCache.map.size && Date.now() - ctValCache.ts < 6 * 3600_000) return ctValCache.map;
  if (ctValCache.inflight) return ctValCache.inflight;
  ctValCache.inflight = (async () => {
    try {
      const j = await fetchJson<{ code: string; data?: Array<{ instId: string; ctVal: string }> }>(
        'https://www.okx.com/api/v5/public/instruments?instType=SWAP', 10_000);
      if (j.code === '0' && j.data) {
        for (const i of j.data) {
          const v = parseFloat(i.ctVal);
          if (v > 0) ctValCache.map.set(i.instId, v);
        }
        ctValCache.ts = Date.now();
      }
    } catch {
      /* оставляем предыдущую карту */
    }
    ctValCache.inflight = null;
    return ctValCache.map;
  })();
  return ctValCache.inflight;
}

export async function fetchOkxLiquidations(
  instId: string,
  instFamily: string,
  price: number
): Promise<LiqInfo | null> {
  try {
    const ctVals = await getOkxCtVal();
    const ctVal = ctVals.get(instId);
    if (!ctVal || ctVal <= 0) return null;
    const j = await fetchJson<{ code: string; data?: Array<{ details?: Array<{ ts: string; sz: string; posSide: string }> }> }>(
      `https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&instFamily=${instFamily}&instId=${instId}&state=filled&limit=100`, 8000);
    if (j.code !== '0' || !j.data?.[0]?.details) return null;
    const now = Date.now();
    let liq5 = 0, liq15 = 0, longUsd = 0, shortUsd = 0, latest = 0;
    for (const d of j.data[0].details) {
      const ts = Number(d.ts);
      if (now - ts > 15 * 60_000) continue;
      const usd = parseFloat(d.sz) * ctVal * price;
      if (usd <= 0) continue;
      liq15 += usd;
      if (now - ts <= 5 * 60_000) liq5 += usd;
      if (d.posSide === 'long') longUsd += usd;
      else shortUsd += usd;
      if (ts > latest) latest = ts;
    }
    return { liq5mUsd: liq5, liq15mUsd: liq15, longUsd, shortUsd, latestTs: latest || null };
  } catch (e) {
    console.error('[okx-liq]', instId, e instanceof Error ? e.message : e);
    return null;
  }
}

/* ---------------- LONG/SHORT RATIO розницы ----------------
   Bybit account-ratio (доля аккаунтов в лонгах, период 5min) — основной;
   OKX rubik long-short-account-ratio (коэффициент) — фолбэк. */

export interface LsrInfo {
  longPct: number; // 0..100
  ratio: number | null; // long/short
  src: ExchangeId;
}

export async function fetchLsr(ex: ExchangeId, ccy: string, native: string): Promise<LsrInfo | null> {
  try {
    if (ex === 'bybit') {
      const j = await fetchJson<{ retCode: number; result?: { list?: Array<{ buyRatio: string; sellRatio: string }> } }>(
        `https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${native}&period=5min&limit=1`, 8000);
      const row = j.retCode === 0 ? j.result?.list?.[0] : undefined;
      if (!row) return null;
      const buy = parseFloat(row.buyRatio);
      const sell = parseFloat(row.sellRatio);
      if (!(buy >= 0) || !(sell > 0)) return null;
      return { longPct: (buy / (buy + sell)) * 100, ratio: buy / sell, src: 'bybit' };
    }
    if (ex === 'okx') {
      const j = await fetchJson<{ code: string; data?: Array<[string, string]> }>(
        `https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&instId=${native}&period=5m&limit=1`, 8000);
      const row = j.code === '0' ? j.data?.[0] : undefined;
      if (!row) return null;
      const ratio = parseFloat(row[1]);
      if (!(ratio > 0)) return null;
      return { longPct: (ratio / (1 + ratio)) * 100, ratio, src: 'okx' };
    }
    return null;
  } catch (e) {
    console.error('[lsr]', ex, ccy, e instanceof Error ? e.message : e);
    return null;
  }
}

