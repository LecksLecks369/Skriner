/* НЕЛИКВИД + алго-детектор: анализ стакана и ленты сделок.
   Паттерн «робот вошёл в неликвид»: механические клипы фиксированного размера,
   регулярные интервалы, всплеск тейкер-агрессии + тонкий стакан + разошедшийся спред. */

import type { Book, TapeTrade } from './exchanges';
import type { Candle, ExchangeId, ExDepth, LiquidityDeep, TapeStats } from './types';

const MAX_SLIP_PCT = 0.3; // порог «безопасного» проскальзывания для max-позиции

/* ---------------- Стакан ---------------- */

function depthWithin(levels: { p: number; s: number }[], mid: number, bandPct: number, side: 'bid' | 'ask'): number {
  let sum = 0;
  for (const l of levels) {
    const dev = Math.abs(l.p - mid) / mid;
    if (dev > bandPct) break; // уровни отсортированы по удалённости от mid
    void side;
    sum += l.p * l.s;
  }
  return sum;
}

/** Проскальзывание рыночного ордера на $budget по уровней книги; null если стакана не хватило */
export function slipForUsd(levels: { p: number; s: number }[], mid: number, budgetUsd: number): number | null {
  let filled = 0;
  let cost = 0;
  for (const l of levels) {
    const lvlUsd = l.p * l.s;
    const take = Math.min(lvlUsd, budgetUsd - filled);
    filled += take;
    cost += take * l.p;
    if (filled >= budgetUsd - 1e-9) break;
  }
  if (filled < budgetUsd * 0.999) return null; // книга мельче ордера
  const avg = cost / filled;
  return (Math.abs(avg - mid) / mid) * 100;
}

/** Максимальный размер ордера (USD) с слипейджем ≤ maxSlipPct по одной стороне */
export function maxSizeForSlip(levels: { p: number; s: number }[], mid: number, maxSlipPct = MAX_SLIP_PCT): number {
  let filled = 0;
  let cost = 0;
  for (const l of levels) {
    const lvlUsd = l.p * l.s;
    const prevFilled = filled;
    filled += lvlUsd;
    cost += lvlUsd * l.p;
    const avg = cost / filled;
    if ((Math.abs(avg - mid) / mid) * 100 > maxSlipPct) return Math.max(0, prevFilled);
  }
  return filled;
}

export function analyzeBook(book: Book): ExDepth | null {
  const bestBid = book.bids[0]?.p ?? 0;
  const bestAsk = book.asks[0]?.p ?? 0;
  if (!bestBid || !bestAsk || bestAsk <= bestBid) return null;
  const mid = (bestBid + bestAsk) / 2;
  const worst = (a: number | null, b: number | null): number | null => {
    if (a == null && b == null) return null;
    if (a == null) return b;
    if (b == null) return a;
    return Math.max(a, b);
  };
  const slip = (budget: number) => worst(slipForUsd(book.asks, mid, budget), slipForUsd(book.bids, mid, budget));
  return {
    depth10Usd: depthWithin(book.asks, mid, 0.001, 'ask') + depthWithin(book.bids, mid, 0.001, 'bid'),
    depth25Usd: depthWithin(book.asks, mid, 0.0025, 'ask') + depthWithin(book.bids, mid, 0.0025, 'bid'),
    depth50Usd: depthWithin(book.asks, mid, 0.005, 'ask') + depthWithin(book.bids, mid, 0.005, 'bid'),
    bookSpreadPct: ((bestAsk - bestBid) / mid) * 100,
    slip10kPct: slip(10_000),
    slip25kPct: slip(25_000),
    slip50kPct: slip(50_000),
    maxPosUsd: Math.min(maxSizeForSlip(book.asks, mid), maxSizeForSlip(book.bids, mid)),
  };
}

/* ---------------- Лента сделок ---------------- */

function sig2(x: number): number {
  // округление до 2 значащих цифр — бакет для поиска клипов
  if (x <= 0) return 0;
  return Number(x.toPrecision(2));
}

function cvOf(gaps: number[]): number | null {
  if (gaps.length < 4) return null;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean <= 0) return null;
  const varr = gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gaps.length;
  return Math.sqrt(varr) / mean;
}

export function analyzeTape(trades: TapeTrade[], now = Date.now()): TapeStats | null {
  if (!trades || trades.length < 10) return null;
  const newest = trades[trades.length - 1].ts;
  const oldest = trades[0].ts;
  const windowSec = Math.max(1, Math.round((newest - oldest) / 1000));
  if (now - newest > 5 * 60_000) return null; // лента протухла (монета не торгуется)

  let buy = 0;
  let total = 0;
  let bigBuy = 0;
  let bigSell = 0;
  for (const t of trades) {
    total += t.usd;
    if (t.taker === 'buy') buy += t.usd;
    if (t.usd >= 100_000) {
      if (t.taker === 'buy') bigBuy += t.usd;
      else bigSell += t.usd;
    }
  }
  const aggression = total > 0 ? (buy - (total - buy)) / total : 0;
  const tradesPerMin = (trades.length / windowSec) * 60;

  // кластер одноразмерных клипов: группируем по ~2 значащим цифрам, берём модальный бакет
  const buckets = new Map<number, TapeTrade[]>();
  for (const t of trades) {
    const k = sig2(t.usd);
    if (k < 100) continue; // пыль не считаем
    const arr = buckets.get(k);
    if (arr) arr.push(t);
    else buckets.set(k, [t]);
  }
  let modal: TapeTrade[] = [];
  for (const arr of buckets.values()) if (arr.length > modal.length) modal = arr;
  if (modal.length < 5) {
    modal = [];
  }
  let clipRatio = 0;
  let clipCount = 0;
  let clipUsd = 0;
  let gapCv: number | null = null;
  if (modal.length >= 5) {
    const clipVol = modal.reduce((s, t) => s + t.usd, 0);
    clipRatio = total > 0 ? clipVol / total : 0;
    clipCount = modal.length;
    clipUsd = clipVol / modal.length;
    const gaps: number[] = [];
    for (let i = 1; i < modal.length; i++) {
      const dt = modal[i].ts - modal[i - 1].ts;
      if (dt > 30_000) continue; // разрывы окна не портим
      gaps.push(dt);
    }
    gapCv = cvOf(gaps);
  }

  return {
    windowSec,
    trades: trades.length,
    tradesPerMin: Math.round(tradesPerMin * 10) / 10,
    aggression: Math.round(aggression * 1000) / 1000,
    clipRatio: Math.round(clipRatio * 1000) / 1000,
    clipCount,
    clipUsd: Math.round(clipUsd),
    gapCv: gapCv != null ? Math.round(gapCv * 100) / 100 : null,
    bigNetUsd: Math.round(bigBuy - bigSell),
  };
}

/* ---------------- Скоринг ---------------- */

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
/** лог-интерполяция: 0 при x<=lo, 1 при x>=hi */
const logScale = (x: number, lo: number, hi: number) => clamp((Math.log(Math.max(x, 1e-9)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)));

/** Амихуд: среднее |доходность| / (объём в $M) за n минут — % движения на $1M */
export function amihudPct(candles: Candle[], n = 30): number | null {
  if (candles.length < n + 1) return null;
  const slice = candles.slice(-n - 1);
  const vals: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].c;
    const qv = slice[i].qv || slice[i].v;
    if (!prev || !qv) continue;
    vals.push((Math.abs(slice[i].c - prev) / prev) / (qv / 1e6));
  }
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
}

export interface AlgoInput {
  tape: TapeStats | null;
  volZ: number | null;
  dOiPct15m: number | null;
  sweepAgeMin: number | null; // возраст свежего свипа или null
}

/**
 * Алго-скор 0-100: клипы 30 + регулярность 25 + агрессия 20 + интенсивность 15
 * + подтверждение OI/объёмом 10.
 */
export function algoScoreOf(inp: AlgoInput): number {
  const t = inp.tape;
  let clips = 0;
  let reg = 0;
  let aggr = 0;
  let burst = 0;
  if (t) {
    if (t.clipCount >= 5) clips = 30 * clamp(t.clipRatio / 0.5);
    if (t.clipCount >= 5 && t.gapCv != null) reg = 25 * clamp((0.8 - t.gapCv) / 0.6);
    aggr = 20 * clamp(Math.abs(t.aggression) / 0.5);
    burst = 15 * clamp(t.tradesPerMin / 150);
  }
  const conf =
    10 *
    (0.5 * clamp((inp.volZ ?? 0) / 3) + 0.5 * clamp(Math.abs(inp.dOiPct15m ?? 0) / 1.0));
  return Math.round(clamp(clips + reg + aggr + burst + conf, 0, 100));
}

/** Скор неликвидности 0-100 (больше = неликвиднее): глубина 40 + слипейдж 30 + Амихуд 20 + оборот 10 */
export function illiqScoreOf(depth25Usd: number | null, slip25k: number | null, amihud: number | null, turnoverUsd: number): number {
  // глубина в ±0.25%: ≥$2M → 0, ≤$10k → 40
  const dDepth = depth25Usd != null ? 40 * (1 - logScale(depth25Usd, 10_000, 2_000_000)) : 15;
  // слипейдж $25k: 0% → 0, ≥0.8% → 30
  const dSlip = slip25k != null ? 30 * logScale(Math.max(slip25k, 0.01), 0.02, 0.8) : 10;
  // Амихуд: 0.01%/1M → 0, 2%/1M → 20
  const dAmi = amihud != null ? 20 * logScale(Math.max(amihud, 0.001), 0.02, 2) : 8;
  // оборот 24ч: ≥$500M → 0, ≤$5M → 10
  const dTurn = 10 * (1 - logScale(turnoverUsd, 5_000_000, 500_000_000));
  return Math.round(clamp(dDepth + dSlip + dAmi + dTurn, 0, 100));
}

/** Дешёвая оценка для всех монет (без запросов стакана): Амихуд 55 + оборот 30 + спред 15 */
export function illiqProxyOf(amihud: number | null, turnoverUsd: number, crossSpreadPct: number | null): number {
  const dAmi = amihud != null ? 55 * logScale(Math.max(amihud, 0.001), 0.02, 2) : 20;
  const dTurn = 30 * (1 - logScale(turnoverUsd, 5_000_000, 500_000_000));
  const dSpr = crossSpreadPct != null ? 15 * clamp(crossSpreadPct / 0.6) : 0;
  return Math.round(clamp(dAmi + dTurn + dSpr, 0, 100));
}

/** Дешёвый прокси алго-всплеска для всех монет (без ленты): объём 45 + ΔOI 35 + свип 20 */
export function algoProxyOf(volZ: number | null, dOiPct15m: number | null, sweepAgeMin: number | null): number {
  const dVol = volZ != null ? 45 * clamp((volZ - 0.8) / 2.2) : 0;
  const dOi = dOiPct15m != null ? 35 * clamp(Math.abs(dOiPct15m) / 1.2) : 0;
  const dSweep = sweepAgeMin != null ? 20 * clamp((20 - sweepAgeMin) / 20) : 0;
  return Math.round(clamp(dVol + dOi + dSweep, 0, 100));
}

/* ---------------- Паттерн «робот вошёл в неликвид» ---------------- */

export function buildPattern(
  algo: number,
  illiq: number,
  netSpreadPct: number | null,
  crossSpreadPct: number | null,
  tape: TapeStats | null,
  depth25Usd: number | null,
  slip25k: number | null,
  dOiPct15m: number | null
): { robotIlliquid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (tape && tape.clipCount >= 5 && tape.clipRatio >= 0.3)
    reasons.push(`клипы ${Math.round(tape.clipRatio * 100)}% объёма (~$${tape.clipUsd >= 1000 ? Math.round(tape.clipUsd / 1000) + 'K' : Math.round(tape.clipUsd)}, ×${tape.clipCount})`);
  if (tape && tape.gapCv != null && tape.gapCv <= 0.45) reasons.push(`механический интервал (CV ${tape.gapCv})`);
  if (tape && Math.abs(tape.aggression) >= 0.3)
    reasons.push(`тейкер-агрессия ${tape.aggression > 0 ? '+' : ''}${tape.aggression.toFixed(2)}`);
  if (dOiPct15m != null && Math.abs(dOiPct15m) >= 0.4)
    reasons.push(`ΔOI ${dOiPct15m > 0 ? '+' : ''}${dOiPct15m.toFixed(2)}%/15м`);
  if (depth25Usd != null && depth25Usd < 120_000)
    reasons.push(`тонкий стакан $${depth25Usd >= 1000 ? Math.round(depth25Usd / 1000) + 'K' : Math.round(depth25Usd)} в ±0.25%`);
  if (slip25k != null && slip25k >= 0.15) reasons.push(`слипейдж $25k: ${slip25k.toFixed(2)}%`);
  if (netSpreadPct != null && netSpreadPct >= 0.15) reasons.push(`нетто ${netSpreadPct.toFixed(2)}%`);
  else if (crossSpreadPct != null && crossSpreadPct >= 0.3) reasons.push(`спред ${crossSpreadPct.toFixed(2)}%`);

  const robotIlliquid = algo >= 55 && illiq >= 50 && (netSpreadPct != null && netSpreadPct >= 0.15 || (crossSpreadPct ?? 0) >= 0.3);
  return { robotIlliquid, reasons };
}

/* ---------------- Сборка deep-блока монеты ---------------- */

export interface DeepInput {
  entryEx: ExchangeId | null;
  exitEx: ExchangeId | null;
  depths: Partial<Record<ExchangeId, ExDepth>>;
  tape: TapeStats | null;
  tapeEx: ExchangeId | null;
  amihud: number | null;
  volZ: number | null;
  dOiPct15m: number | null;
  sweepAgeMin: number | null;
  netSpreadPct: number | null;
  crossSpreadPct: number | null;
  turnoverUsd: number;
}

export function assembleDeep(inp: DeepInput): LiquidityDeep {
  // худший слипейдж и минимальная max-позиция среди бирж входа/выхода
  const rel = [inp.entryEx, inp.exitEx].filter((x): x is ExchangeId => !!x && !!inp.depths[x]);
  let slip25k: number | null = null;
  let maxPos: number | null = null;
  let depth25: number | null = null;
  for (const ex of rel) {
    const d = inp.depths[ex]!;
    if (d.slip25kPct != null && (slip25k == null || d.slip25kPct > slip25k)) slip25k = d.slip25kPct;
    if (maxPos == null || d.maxPosUsd < maxPos) maxPos = d.maxPosUsd;
    if (depth25 == null || d.depth25Usd < depth25) depth25 = d.depth25Usd;
  }
  const algo = algoScoreOf({ tape: inp.tape, volZ: inp.volZ, dOiPct15m: inp.dOiPct15m, sweepAgeMin: inp.sweepAgeMin });
  const illiq = illiqScoreOf(depth25, slip25k, inp.amihud, inp.turnoverUsd);
  const pattern = buildPattern(algo, illiq, inp.netSpreadPct, inp.crossSpreadPct, inp.tape, depth25, slip25k, inp.dOiPct15m);
  return {
    ts: Date.now(),
    perEx: inp.depths,
    entryEx: inp.entryEx,
    exitEx: inp.exitEx,
    slip25kPct: slip25k,
    maxPosUsd: maxPos,
    tape: inp.tape,
    tapeEx: inp.tapeEx,
    amihudPct: inp.amihud,
    algoScore: algo,
    illiqScore: illiq,
    pattern,
  };
}

