/* Единая модель издержек круга — общая для бумажных сделок и для оценки исходов паттернов.

   Зачем отдельный файл: модель была размазана по двум местам и в обоих неполна.
   paper.ts вычитал проскальзывание, но не комиссии — они сокращались в разности
   netEntry − netExit (оба нетто-спреда посчитаны за вычетом комиссий ОДНОГО
   пересечения), и круг оказывался бесплатным по комиссиям. patterns.ts не вычитал
   ничего вообще, поэтому тейк +0.4% записывался как выигрыш, хотя круг тейкером
   съедает ~0.11% ещё до проскальзывания.

   Правило одно: издержки считаются здесь, и любая метрика результата обязана
   пройти через эти функции. */

import { EXCHANGES, type ExchangeId } from './types';

const FEE = Object.fromEntries(EXCHANGES.map((e) => [e.id, e.takerFee])) as Record<ExchangeId, number>;
/** Комиссия неизвестной биржи: берём медиану списка, чтобы не занизить издержки нулём */
const FALLBACK_TAKER = 0.00055;

function taker(ex: ExchangeId | null | undefined): number {
  return (ex && FEE[ex]) ?? FALLBACK_TAKER;
}

/** Комиссия ОДНОГО пересечения пары книг: покупка на a + продажа на b, % от номинала */
export function feePairPct(a: ExchangeId, b: ExchangeId): number {
  return (taker(a) + taker(b)) * 100;
}

/** Комиссии полного арбитражного круга: пара пересекается дважды — вход и выход, % */
export function arbFeesPct(a: ExchangeId, b: ExchangeId): number {
  return 2 * feePairPct(a, b);
}

/**
 * Полная стоимость круга: комиссии обеих ног дважды + проскальзывание входа и выхода.
 * slipRoundTripPct — стоимость одного пересечения обеих книг (из deep-блока);
 * null = стакан неизвестен, тогда учтены только комиссии и результат завышен.
 */
export function arbCostPct(a: ExchangeId, b: ExchangeId, slipRoundTripPct: number | null | undefined): number {
  const slip = typeof slipRoundTripPct === 'number' && Number.isFinite(slipRoundTripPct) ? Math.max(0, slipRoundTripPct) : 0;
  return arbFeesPct(a, b) + 2 * slip;
}

/**
 * P&L арбитражной сделки: (нетто-спред входа − нетто-спред выхода) − издержки круга.
 * Комиссии в разности сокращаются, поэтому costPct содержит их целиком.
 */
export function arbPnlPct(netEntry: number, netExit: number, costPct: number): number {
  return netEntry - netExit - costPct;
}

/** Стоимость удержания: нетто-фандинг обеих ног × время в позиции, % от номинала */
export function arbHoldCostPct(fundingHourlyPct: number | null | undefined, heldMs: number): number {
  if (fundingHourlyPct == null || !Number.isFinite(fundingHourlyPct)) return 0;
  return (fundingHourlyPct * Math.max(0, heldMs)) / 3_600_000;
}

/**
 * Полные издержки сделки: комиссии круга + слипейдж входа и выхода + фандинг удержания.
 *
 * Живёт здесь, а не в paper.ts, потому что считают их ДВОЕ: сервер при закрытии и
 * панель при показе открытой позиции. Пока выражение было только серверным, панель
 * складывала свою версию из arbCostPct и показывала P&L без стоимости удержания —
 * то есть цифра на экране и цифра в журнале расходились тем сильнее, чем дольше
 * висела позиция, и обе выглядели правдоподобно.
 */
export function arbTotalCostPct(
  a: ExchangeId,
  b: ExchangeId,
  slipRoundTripPct: number | null | undefined,
  fundingHourlyPct: number | null | undefined,
  heldMs: number
): number {
  return arbCostPct(a, b, slipRoundTripPct) + arbHoldCostPct(fundingHourlyPct, heldMs);
}

/** Максимум, который сделка может дать: спред схлопнулся в ноль. ≤0 = сделка убыточна изначально */
export function arbMaxPnlPct(netEntry: number, costPct: number): number {
  return netEntry - costPct;
}

/**
 * Цель тейка в терминах P&L: 35% достижимой прибыли, но не меньше 0.05 п.п.
 * и не больше самого достижимого максимума. null = прибыль недостижима,
 * такая сделка может закрыться только стопом, схлопыванием или таймаутом.
 */
export function arbTpTargetPct(netEntry: number, costPct: number): number | null {
  const max = arbMaxPnlPct(netEntry, costPct);
  if (max <= 0) return null;
  return Math.min(max, Math.max(0.05, max * 0.35));
}

/** Уровень схлопывания: спред сжался до трети входа (но не строже 0.05%) — эджа больше нет */
export function arbConvergeLevelPct(netEntry: number): number {
  return Math.max(0.05, netEntry * 0.35);
}

/** Стоп: разрыв разошёлся ещё на столько п.п. против позиции */
export const ARB_SL_WIDEN_PCT = 0.25;

export function arbSlLevelPct(netEntry: number): number {
  return netEntry + ARB_SL_WIDEN_PCT;
}

/** Круг направленной сделки на одной бирже: вход и выход тейкером, % от номинала */
export function directionalCostPct(ex: ExchangeId | null | undefined): number {
  return 2 * taker(ex) * 100;
}

/**
 * Нетто-фандинг арбитражной позиции, % от номинала В ЧАС.
 *
 * Позиция маркет-нейтральна по цене, но не по фандингу: длинная нога платит свою
 * ставку, короткая получает свою, и на удержании в несколько часов разность
 * крупнее комиссий круга. Ставки приводятся к часу — интервалы у бирж разные
 * (1ч/4ч/8ч), и складывать их как есть нельзя. Интервал неизвестен → берётся 8ч
 * как самый распространённый; это допущение, и оно занижает вклад часовых ставок.
 *
 * Знак: результат — ИЗДЕРЖКА. Отрицательное значение значит, что карри платит в нашу
 * сторону.
 */
export function fundingHourlyPctOf(
  buy: { fundingRate: number | null; fundingIntervalMin: number | null } | null | undefined,
  sell: { fundingRate: number | null; fundingIntervalMin: number | null } | null | undefined
): number | null {
  const perHour = (f: { fundingRate: number | null; fundingIntervalMin: number | null } | null | undefined) => {
    if (!f || f.fundingRate == null) return null;
    const mins = f.fundingIntervalMin && f.fundingIntervalMin > 0 ? f.fundingIntervalMin : 480;
    return f.fundingRate * (60 / mins) * 100;
  };
  const b = perHour(buy);
  const s = perHour(sell);
  if (b == null || s == null) return null;
  // длинная нога на buyEx платит b, короткая на sellEx получает s
  return Math.round((b - s) * 10_000) / 10_000;
}
