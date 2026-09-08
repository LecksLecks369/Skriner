/* Сетапы движения: ПРОБОЙ (до того, как он случился), ЁРШ (пила/ложные пробои)
   и РАЗДАЧА/НАБОР (памп-дамп с распределением позиции крупным участником).

   Все три считаются по 1м-свечам, доступным для каждой строки скана, и уточняются
   лентой/ликвидациями там, где они есть (топ-40 по скору). Каждый сетап пишется
   в историю паттернов и получает измеренный исход — детектор без win-rate это
   украшение, а не сигнал. */

import { atr } from './score';
import type { BreakoutSetup, Candle, ChopState, DistributionState, TapeStats } from './types';

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

/* ============================ ПРОБОЙ ============================ */

const RANGE_BARS = 60; // окно, по которому строится уровень
const SKIP_BARS = 2; // последние свечи в уровень не входят: иначе уровень = текущая цена
const COMPRESS_BARS = 15;

export interface BreakoutInput {
  volZ: number | null;
  dOiPct15m: number | null;
  cvd: number | null; // агрессия -1..1 (тейкерская из ленты либо прокси по свечам)
  chopScore: number; // 0-100, ёрш: чем выше, тем чаще пробои ложные
}

/**
 * Готовность к пробою: цена прижата к границе диапазона, волатильность сжата,
 * уровень уже проверялся, позиции набираются (ΔOI), агрессия смотрит в ту же сторону.
 *
 * Смысл сигнала — предупредить ДО выхода за уровень: fired=false и высокий score.
 * После выхода за уровень строка остаётся (fired=true), но это уже подтверждение,
 * а не прогноз, и в историю паттернов такой сигнал не пишется.
 */
export function detectBreakout(candles: Candle[], inp: BreakoutInput): BreakoutSetup | null {
  if (candles.length < RANGE_BARS + SKIP_BARS + 5) return null;
  const price = candles[candles.length - 1].c;
  if (!price || !isFinite(price)) return null;
  const a = atr(candles);
  if (!a || a <= 0) return null;

  const win = candles.slice(-(RANGE_BARS + SKIP_BARS), -SKIP_BARS);
  if (win.length < 20) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of win) {
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  if (!isFinite(hi) || !isFinite(lo) || hi <= lo) return null;
  const mid = (hi + lo) / 2;
  const rangePct = ((hi - lo) / mid) * 100;

  // до какой границы ближе — та и есть рабочая сторона (отрицательное = цена уже вышла)
  const distUp = ((hi - price) / price) * 100;
  const distDown = ((price - lo) / price) * 100;
  const dir: 'up' | 'down' = distUp <= distDown ? 'up' : 'down';
  const level = dir === 'up' ? hi : lo;
  const distPct = dir === 'up' ? distUp : distDown;
  const distAtr = Math.abs(price - level) / a;
  const fired = dir === 'up' ? price > hi + 0.15 * a : price < lo - 0.15 * a;

  // сколько раз уровень уже тестировался: уровень с одним касанием — не уровень
  let touches = 0;
  for (const c of win) {
    if (dir === 'up' ? c.h >= hi - 0.3 * a : c.l <= lo + 0.3 * a) touches++;
  }

  const atrShort = atr(candles, COMPRESS_BARS);
  const atrLong = candles.length >= RANGE_BARS + 1 ? atr(candles, RANGE_BARS) : null;
  const squeeze = atrShort != null && atrLong != null && atrLong > 0 ? atrShort / atrLong : 1;

  const reasons: string[] = [];
  let score = 0;

  // 1. Близость к уровню (30) — в ATR, а не в процентах: 0.3 ATR у разных монет разное в %
  score += 30 * clamp((2 - distAtr) / 1.7);
  if (distAtr <= 0.6 && !fired) {
    reasons.push('цена в ' + distAtr.toFixed(2) + ' ATR от уровня ' + (dir === 'up' ? 'сверху' : 'снизу'));
  }

  // 2. Сжатие волатильности (20): ATR 15м против ATR 60м
  score += 20 * clamp((1 - squeeze) / 0.4);
  if (squeeze <= 0.75) reasons.push('сжатие x' + squeeze.toFixed(2) + ' (ATR 15м/60м)');

  // 3. Качество уровня (15)
  score += Math.min(15, Math.max(0, touches - 1) * 5);
  if (touches >= 3) reasons.push('уровень тестировался ' + touches + '×');

  // 4. Набор позиций (15) — знак не важен: перед пробоем набирают обе стороны
  const doi = inp.dOiPct15m != null ? Math.abs(inp.dOiPct15m) : 0;
  score += 15 * clamp(doi / 0.8);
  if (doi >= 0.4 && inp.dOiPct15m != null) {
    reasons.push('ΔOI ' + (inp.dOiPct15m > 0 ? '+' : '') + inp.dOiPct15m.toFixed(2) + '%/15м');
  }

  // 5. Давление объёма (10): цену держат у границы на растущем объёме — стенку продавливают
  score += 10 * clamp(((inp.volZ ?? 0) - 0.5) / 2);
  if ((inp.volZ ?? 0) >= 1.5) reasons.push('объём z=' + inp.volZ!.toFixed(1));

  // 6. Агрессия в сторону пробоя (10)
  const cvd = inp.cvd ?? 0;
  const aligned = dir === 'up' ? cvd > 0 : cvd < 0;
  if (aligned) {
    score += 10 * clamp(Math.abs(cvd) / 0.4);
    if (Math.abs(cvd) >= 0.2) reasons.push('агрессия ' + (cvd > 0 ? 'покупателя' : 'продавца') + ' ' + cvd.toFixed(2));
  }

  /* Ёрш штрафует готовность: в пиле граница диапазона протыкается по десять раз
     на дню, и каждый такой «пробой» — ложный. */
  if (inp.chopScore >= 40) {
    score *= 1 - 0.45 * clamp((inp.chopScore - 40) / 50);
    reasons.push('⚠ ёрш ' + Math.round(inp.chopScore) + ' — пробой может быть ложным');
  }

  const finalScore = Math.round(clamp(score, 0, 100));
  if (finalScore < 20) return null;
  return {
    dir,
    score: finalScore,
    level,
    distPct: Math.round(distPct * 1000) / 1000,
    distAtr: Math.round(distAtr * 100) / 100,
    rangePct: Math.round(rangePct * 100) / 100,
    squeeze: Math.round(squeeze * 100) / 100,
    touches,
    fired,
    reasons,
  };
}

/* ============================= ЁРШ ============================== */

const CHOP_BARS = 30;

/* Порог эффективности, ниже которого движение считается пилой. Тот же порог служит
   критерием исхода: сигнал проверяется той же величиной на будущем окне, а не
   подставной полосой цены со своим свободным параметром. */
export const CHOP_ER_MAX = 0.32;
export const CHOP_SCORE_MIN = 55;

/**
 * «Ёрш» — пила: цена много ходит и никуда не приходит. Ложные пробои, выбитые стопы
 * с обеих сторон, длинные тени, тейкер-поток без перевеса.
 *
 * Основа — коэффициент эффективности Кауфмана: чистое смещение, делённое на пройденный
 * путь. 1 = прямая линия, 0 = топтание. Он и отличает тренд от пилы при одинаковой
 * волатильности, которую NATR показывает одинаковой.
 */
export function detectChop(candles: Candle[], tape: TapeStats | null): ChopState | null {
  if (candles.length < CHOP_BARS + 2) return null;
  const win = candles.slice(-CHOP_BARS);
  const a = atr(candles);

  let path = 0;
  for (let i = 1; i < win.length; i++) path += Math.abs(win[i].c - win[i - 1].c);
  if (path <= 0) return null;
  const net = Math.abs(win[win.length - 1].c - win[0].c);
  const er = clamp(net / path);

  // смены направления свечей
  let flipsN = 0;
  let prevSign = 0;
  for (const c of win) {
    const s = Math.sign(c.c - c.o);
    if (s !== 0 && prevSign !== 0 && s !== prevSign) flipsN++;
    if (s !== 0) prevSign = s;
  }
  const flips = flipsN / (win.length - 1);

  // доля свечей, где тени длиннее тела — цену возят и возвращают
  let wicky = 0;
  for (const c of win) {
    const body = Math.abs(c.c - c.o);
    const wick = c.h - c.l - body;
    if (wick > 1.5 * body) wicky++;
  }
  const wickRatio = wicky / win.length;

  // выносы в обе стороны за окно: стопы сняли и сверху, и снизу
  let up = false;
  let down = false;
  if (a && a > 0) {
    for (const c of win) {
      const body = Math.abs(c.c - c.o);
      const upper = c.h - Math.max(c.o, c.c);
      const lower = Math.min(c.o, c.c) - c.l;
      if (upper >= 1.2 * a && upper > body) up = true;
      if (lower >= 1.2 * a && lower > body) down = true;
    }
  }
  const bothSides = up && down;

  let score = 0;
  score += 35 * clamp((0.35 - er) / 0.3);
  score += 25 * clamp((flips - 0.35) / 0.35);
  score += 20 * clamp((wickRatio - 0.3) / 0.4);
  score += bothSides ? 10 : 0;
  // много сделок без перевеса стороны — характерная лента пилы
  if (tape && tape.tradesPerMin >= 30 && Math.abs(tape.aggression) <= 0.12) score += 10;

  const final = Math.round(clamp(score, 0, 100));
  return {
    score: final,
    er: Math.round(er * 1000) / 1000,
    flips: Math.round(flips * 100) / 100,
    wickRatio: Math.round(wickRatio * 100) / 100,
    bothSides,
    isErsh: final >= CHOP_SCORE_MIN && er <= CHOP_ER_MAX,
  };
}

/* ====================== РАЗДАЧА / НАБОР ========================= */

export interface DistInput {
  natrPct: number | null;
  dOiPct15m: number | null;
  cvd: number | null;
  tape: TapeStats | null;
  whaleNetUsd: number | null;
  lsrLongPct: number | null;
  fundingSigned: number | null; // ставка со знаком, приведённая к 8ч
  liqLongUsd: number | null;
  liqShortUsd: number | null;
}

const MOVE_BARS = 15;

/**
 * Раздача/набор: монету двигают, но поток против движения.
 *
 * Ключ — расхождение цены и открытого интереса. Рост цены при ПАДАЮЩЕМ OI это не
 * покупки, а закрытие шортов: топливо кончается вместе с шортами, и памп кончается
 * тоже. Плюс подтверждения: тейкер-поток против хода, киты в противоход, толпа
 * набилась в ту же сторону, перегретый фандинг, вынос противоположной стороны.
 *
 * Тот же памп при РАСТУЩЕМ OI и покупках — обычный тренд (kind pump_trend),
 * контр-сигналом не является и в историю паттернов не пишется.
 */
export function detectDistribution(candles: Candle[], inp: DistInput): DistributionState | null {
  if (candles.length < MOVE_BARS + 2) return null;
  const last = candles[candles.length - 1].c;
  const base = candles[candles.length - 1 - MOVE_BARS].c;
  if (!last || !base) return null;
  const movePct = ((last - base) / base) * 100;

  /* Порог движения — от собственной волатильности монеты: 0.8% для BTC это событие,
     для мем-коина с NATR 1.5% — шум. */
  const natr = inp.natrPct ?? 0.3;
  const trigger = Math.max(0.7, 2.2 * natr);
  if (Math.abs(movePct) < trigger) return null;
  const pump = movePct > 0;

  const reasons: string[] = [];
  let score = 0;

  // 1. OI против движения (25): рост на закрытии шортов / падение на закрытии лонгов
  const doi = inp.dOiPct15m;
  if (doi != null && doi <= -0.25) {
    score += 25 * clamp(Math.abs(doi) / 1.0);
    reasons.push((pump ? 'рост' : 'падение') + ' на закрытии позиций (ΔOI ' + doi.toFixed(2) + '%)');
  }

  // 2. Тейкер-поток против движения (20)
  const flow = inp.tape?.aggression ?? inp.cvd;
  if (flow != null && (pump ? flow < -0.05 : flow > 0.05)) {
    score += 20 * clamp(Math.abs(flow) / 0.4);
    reasons.push('поток против хода (' + (flow > 0 ? '+' : '') + flow.toFixed(2) + ')');
  }

  // 3. Крупный участник в противоход (20): киты по ленте Bybit + нетто сделок >$100k
  const whale = inp.whaleNetUsd;
  if (whale != null && (pump ? whale <= -50_000 : whale >= 50_000)) {
    score += 12 * clamp(Math.abs(whale) / 300_000);
    reasons.push('киты ' + (whale > 0 ? 'покупают' : 'продают') + ' ' + Math.round(Math.abs(whale) / 1000) + 'K');
  }
  const big = inp.tape?.bigNetUsd;
  if (big != null && (pump ? big <= -50_000 : big >= 50_000)) {
    score += 8 * clamp(Math.abs(big) / 300_000);
    reasons.push('крупные сделки в противоход ' + Math.round(Math.abs(big) / 1000) + 'K');
  }

  // 4. Толпа набилась в сторону движения (15)
  const lsr = inp.lsrLongPct;
  if (lsr != null && (pump ? lsr >= 60 : lsr <= 42)) {
    score += 15 * clamp((pump ? lsr - 56 : 46 - lsr) / 18);
    reasons.push('розница ' + (pump ? 'в лонгах' : 'в шортах') + ' ' + Math.round(lsr) + '%');
  }

  // 5. Фандинг перегрет в сторону движения (10)
  const f = inp.fundingSigned;
  if (f != null && (pump ? f >= 0.0004 : f <= -0.0004)) {
    score += 10 * clamp((Math.abs(f) - 0.0003) / 0.0008);
    reasons.push('фандинг ' + (f * 100).toFixed(3) + '% — за движение платят');
  }

  // 6. Противоположную сторону уже вынесли (10): топливо израсходовано
  const fuel = pump ? inp.liqShortUsd : inp.liqLongUsd;
  if (fuel != null && fuel >= 50_000) {
    score += 10 * clamp(fuel / 500_000);
    reasons.push((pump ? 'шорты' : 'лонги') + ' вынесены на ' + Math.round(fuel / 1000) + 'K');
  }

  const final = Math.round(clamp(score, 0, 100));
  const counter = final >= 45;
  const kind = pump
    ? counter
      ? ('pump_distribution' as const)
      : ('pump_trend' as const)
    : counter
      ? ('dump_absorption' as const)
      : ('dump_trend' as const);
  if (!counter) {
    reasons.length = 0;
    reasons.push(pump ? 'рост подтверждён потоком и OI — тренд, не раздача' : 'падение подтверждено потоком и OI — тренд, не набор');
  }
  return {
    kind,
    dir: counter ? (pump ? 'short' : 'long') : null,
    score: final,
    movePct: Math.round(movePct * 100) / 100,
    reasons,
  };
}
