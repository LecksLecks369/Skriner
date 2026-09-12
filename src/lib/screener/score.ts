import type { Candle, SweepSignal } from './types';
import { execSpreadPct } from './costs';

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
    sum += tr;
  }
  return sum / period;
}

/** NATR% — нормированный ATR к цене, для сравнения монет между собой */
export function natrPct(candles: Candle[]): number | null {
  const a = atr(candles);
  const last = candles[candles.length - 1];
  if (!a || !last || !last.c) return null;
  return (a / last.c) * 100;
}

/** z-score объёма последней свечи против окна истории */
export function volumeZ(candles: Candle[], window = 60): number | null {
  if (candles.length < 20) return null;
  const hist = candles.slice(-window, -1).map((c) => c.qv || c.v);
  const cur = candles[candles.length - 1];
  const curV = cur.qv || cur.v;
  if (!curV) return 0;
  const n = hist.length;
  const mean = hist.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(hist.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
  if (std < 1e-9) return curV > mean * 3 ? 3 : 0;
  return Math.max(-2, Math.min(8, (curV - mean) / std));
}

/**
 * Детектор снятия ликвидности на 1м/3м свечах:
 * тень >= 1.8x ATR, объём >= 2x среднего, возврат цены в следующих свечах.
 * Ищем в последних 15 свечах; возвращаем самый свежий сигнал.
 */
export function detectSweep(candles: Candle[], intervalMin: number): SweepSignal | null {
  if (candles.length < 25) return null;
  const now = Date.now();
  const n = candles.length;
  const lookback = Math.min(15, n - 20);
  for (let i = n - 1; i >= n - lookback; i--) {
    const c = candles[i];
    if (now - c.ts > 60 * 60 * 1000) break;
    const a = atr(candles.slice(0, i + 1));
    if (!a || a <= 0) continue;
    const body = Math.abs(c.c - c.o);
    const upper = c.h - Math.max(c.o, c.c);
    const lower = Math.min(c.o, c.c) - c.l;
    const qv = c.qv || c.v;
    const avgQv =
      candles.slice(Math.max(0, i - 30), i).reduce((s, x) => s + (x.qv || x.v), 0) /
      Math.max(1, Math.min(30, i));
    if (avgQv <= 0) continue;
    const volMult = qv / avgQv;
    const dir: 'up' | 'down' | null =
      upper >= 1.8 * a && upper > body ? 'up' : lower >= 1.8 * a && lower > body ? 'down' : null;
    if (!dir || volMult < 2) continue;
    // возврат: последующие свечи закрылись внутрь диапазона (wick начал откатываться)
    const after = candles.slice(i + 1);
    if (!after.length) continue;
    const reverted =
      dir === 'up' ? after.some((x) => x.c < Math.max(c.o, c.c)) : after.some((x) => x.c > Math.min(c.o, c.c));
    if (!reverted) continue;
    const ageMin = Math.max(0, Math.round(((now - c.ts) / 60000 - (intervalMin - 1)) * 1));
    return { dir, ageMin, wickAtr: Number(((dir === 'up' ? upper : lower) / a).toFixed(2)), volMult: Number(volMult.toFixed(1)) };
  }
  return null;
}

export interface ScoreInput {
  natrPct: number | null;
  dOiPct15m: number | null;
  dOiPct1h: number | null;
  sweep: SweepSignal | null;
  volZ: number | null;
  netSpreadPct: number | null;
  zScore: number | null;
  coverage: number;
  fundingAbs: number | null;
  /* Глубина стакана (есть только у монет с deep-блоком). Когда не передана —
     спред засчитывается по топу книги, как раньше. */
  slipRoundTripPct?: number | null; // проскальзывание обеих ног круга, %
  maxPosUsd?: number | null; // размер, который стакан тянет со слипейджем ≤0.3%
}

/** Размер, на котором меряется слипейдж в ExDepth ($25k) — база для оценки исполнимости */
const SLIP_BUDGET_USD = 25_000;

/**
 * Исполнимый спред: нетто минус проскальзывание ПОЛНОГО круга (двух пересечений книг).
 * null, если проскальзывание неизвестно — в том числе когда стакан измерялся,
 * но не смог набрать нужный объём. Возвращать здесь сырой нетто нельзя:
 * это давало бы самым тонким книгам вид самых исполнимых.
 *
 * Выражение живёт в costs.ts и здесь только реэкспортируется: пока их было два —
 * скаляр строки вычитал слипейдж один раз, лестница размеров два, — оба поля
 * назывались netExecPct и расходились в одном и том же объекте.
 */
export { execSpreadPct } from './costs';

/**
 * Поправка на размер: спред на $2k книги и спред на $25k книги — разные вещи.
 * 1 при maxPosUsd ≥ $25k, линейно к 0 при ≤ $2k. Без данных — 1 (не штрафуем).
 */
export function sizeViability(maxPosUsd: number | null | undefined): number {
  if (maxPosUsd == null) return 1;
  const floor = 2_000;
  if (maxPosUsd >= SLIP_BUDGET_USD) return 1;
  if (maxPosUsd <= floor) return 0;
  return (maxPosUsd - floor) / (SLIP_BUDGET_USD - floor);
}

export interface ScoreResult {
  score: number;
  parts: Record<string, number>;
}

/** Композитный скор 0-100 с мультибиржевым блоком */
export function computeScore(inp: ScoreInput): ScoreResult {
  const parts: Record<string, number> = {};

  // 1. Волатильность (max 20): оптимум 0.25–1.2% NATR
  if (inp.natrPct != null) {
    const x = inp.natrPct;
    parts.vol = x < 0.1 ? 0 : x < 0.25 ? (x / 0.25) * 14 : x <= 1.2 ? 14 + ((x - 0.25) / 0.95) * 6 : Math.max(6, 20 - (x - 1.2) * 9);
  } else parts.vol = 0;

  // 2. OI-импульс (max 20)
  const d15 = inp.dOiPct15m;
  const d1h = inp.dOiPct1h;
  if (d15 != null || d1h != null) {
    let p = 0;
    const a15 = d15 != null ? Math.abs(d15) : 0;
    const a1h = d1h != null ? Math.abs(d1h) : 0;
    p += Math.min(10, (a15 / 0.8) * 10); // 0.8% за 15м — максимум
    p += Math.min(6, (a1h / 2) * 6); // 2% за час — максимум
    // согласованность знака 15м и 1ч
    if (d15 != null && d1h != null && Math.sign(d15) === Math.sign(d1h) && a15 > 0.15) p += 4;
    parts.oi = Math.min(20, p);
  } else parts.oi = 0;

  // 3. Снятие ликвидности (max 15): свежесть решает
  if (inp.sweep) {
    const s = inp.sweep;
    const fresh = s.ageMin <= 5 ? 1 : s.ageMin <= 15 ? 0.7 : s.ageMin <= 30 ? 0.4 : 0.15;
    const strength = Math.min(1, (s.wickAtr - 1.5) / 1.5) * 0.6 + Math.min(1, (s.volMult - 2) / 4) * 0.4;
    parts.sweep = 15 * fresh * Math.max(0.3, strength);
  } else parts.sweep = 0;

  // 4. Объёмный импульс (max 15)
  parts.volume = inp.volZ != null ? Math.min(15, Math.max(0, ((inp.volZ - 0.5) / 2.5) * 15)) : 0;

  // 5. Мультибиржевой блок (max 20)
  // Спред засчитывается по исполнимой части: минус проскальзывание обеих ног
  // и с поправкой на размер, который стакан вообще тянет. Без данных стакана —
  // как раньше, по топу книги.
  let multi = 0;
  if (inp.slipRoundTripPct === undefined) {
    // стакан не запрашивался (монета вне deep-топа) — как раньше, по котировкам
    if (inp.netSpreadPct != null) multi += Math.min(10, (inp.netSpreadPct / 0.6) * 10); // 0.6% нетто — максимум
  } else {
    // стакан запрашивался: null означает, что книга не набрала объём даже на
    // минимальный бюджет — спред неисполним, баллов за него нет
    const netExec = execSpreadPct(inp.netSpreadPct, inp.slipRoundTripPct);
    /* Обрезка снизу нулём здесь, а не в самом выражении: неисполнимый спред не даёт
       баллов, но и не отнимает их у других слагаемых скора. В самой величине обрезки
       быть не должно — там она уничтожала различие между «чуть-чуть не окупается» и
       «круг дороже разрыва втрое». */
    if (netExec != null) multi += Math.min(10, (Math.max(0, netExec) / 0.6) * 10) * sizeViability(inp.maxPosUsd);
  }
  if (inp.zScore != null && inp.zScore > 0) multi += Math.min(6, (inp.zScore / 3) * 6);
  multi += Math.min(4, Math.max(0, (inp.coverage - 1) * 1.3)); // 2 биржи=1.3, 4 биржи=3.9
  parts.multi = multi;

  // 6. Фандинг-экстрим (max 10)
  parts.funding = inp.fundingAbs != null ? Math.min(10, Math.max(0, ((Math.abs(inp.fundingAbs) - 0.0003) / 0.0005) * 10)) : 0;

  const score = Math.round(Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0)));
  return { score, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])) };
}

/* ---------------- Premium v3 ---------------- */

/**
 * Прокси CVD по свечам: доля объёма растущих свечей минус падающих за n свечей.
 * BingX удалил свой taker-endpoint, поэтому считаем агрессию сами по всем биржам.
 * Возвращает значение -1..1.
 */
export function cvdProxy(candles: Candle[], n = 15): number | null {
  if (candles.length < 10) return null;
  const slice = candles.slice(-n);
  let up = 0;
  let down = 0;
  for (const c of slice) {
    const qv = c.qv || c.v || 0;
    if (!isFinite(qv)) continue;
    if (c.c >= c.o) up += qv;
    else down += qv;
  }
  const total = up + down;
  if (total <= 0) return null;
  return (up - down) / total;
}

function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 30) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Корреляция минутных доходностей с BTC за последний час: ходит ли монета за рынком */
export function btcCorr(candles: Candle[], btc: Candle[]): number | null {
  if (candles.length < 31 || btc.length < 31) return null;
  const rets = (arr: Candle[]): number[] => {
    const out: number[] = [];
    for (let i = arr.length - 60; i < arr.length; i++) {
      if (i <= 0) continue;
      if (arr[i - 1].c > 0) out.push((arr[i].c - arr[i - 1].c) / arr[i - 1].c);
    }
    return out;
  };
  return pearson(rets(candles), rets(btc));
}

