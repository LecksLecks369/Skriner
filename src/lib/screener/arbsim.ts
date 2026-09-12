/* Симуляция арбитражной сделки по снимкам скана — ОДНО выражение на бэктест и оптимизатор.

   Зачем отдельный файл. Модуль издержек costs.ts был заведён с правилом «любая
   метрика результата обязана пройти через эти функции», и в вызывающем коде оно
   соблюдалось — но перечень потребителей никогда не составлялся. Два HTTP-роута
   (/api/backtest и /api/optimize) не импортировали из него ничего: бэктест считал
   исход по снятому в v3 правилу «разрыв схлопнулся вдвое» и вообще без издержек, а
   оптимизатор — как netEntry − netExit, то есть ровно тем выражением, которое
   заголовок costs.ts называет исправленным багом (комиссии сокращаются в разности,
   слипейджа нет). На живом замере оптимизатор рекомендовал самый мягкий порог сетки:
   323 сделки в сутки по +0.136%, при том что симулятор с полными издержками на том
   же типе сделки давал −2.34% на сделку по 148 закрытым позициям.

   Правило выхода здесь то же, что у paper.ts и у simulateSpreadTrade в patterns.ts:
   тейк — доля достижимой прибыли, стоп — расхождение разрыва, схлопывание без
   прибыли — отдельный исход, иначе таймаут.

   ЧЕГО ЭТА СИМУЛЯЦИЯ НЕ УМЕЕТ И ЧТО ОБЯЗАНО ЕХАТЬ РЯДОМ С ЛЮБЫМ ЕЁ ЧИСЛОМ:

   1. Снимок хранит только ЛУЧШУЮ пару бирж на каждом тике, а лучшая пара плавает.
      Путь разрыва поэтому местами сравнивает вход по одной паре с выходом по другой —
      тот самый дефект, ради которого история паттернов перешла на v4 и стала считать
      путь по котировкам своей пары. Здесь исправить нечем: данных о чужой паре в
      снимке нет. Поэтому результат помечается pairDrift и НЕ является той же
      величиной, что win-rate в «Истории».
   2. Слипейдж есть только у строк со стаканом и только в снимках после того, как
      поле появилось. Доля сделок, посчитанных без него, возвращается отдельным
      числом (noSlip) — складывать её в заголовочную цифру нельзя: допущение о
      слипейдже это ровно то, что читатель захочет оспорить. */

import { arbConvergeLevelPct, arbCostPct, arbSlLevelPct, arbTpTargetPct } from './costs';
import type { ExchangeId } from './types';

export type ArbExit = 'tp' | 'sl' | 'converged' | 'timeout';

export interface ArbTick {
  ts: number;
  /** нетто-спред лучшей пары на этот момент, % */
  net: number;
}

export interface ArbSimResult {
  exit: ArbExit;
  /** чистый P&L круга, % от номинала — округлён ДО сравнения с нулём */
  pnlPct: number;
  /** тот же результат до вычета издержек */
  grossPct: number;
  /** издержки круга, вычтенные из результата */
  costPct: number;
  win: boolean;
  /** был ли слипейдж известен; false = учтены только комиссии, результат завышен */
  slipModeled: boolean;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Один сигнал, проведённый по пути разрыва до выхода.
 *
 * netEntry — нетто-спред на входе, %; path — тики строго после входа и внутри
 * горизонта, в хронологическом порядке; slip — слипейдж одного пересечения книг
 * или null, если стакан на момент входа не измерялся.
 *
 * Возвращает null, если пути нет вовсе: исход не «ноль», а отсутствие данных, и
 * подставлять сюда таймаут с нулевым P&L значило бы разбавлять выборку нулями.
 */
export function simulateArb(
  netEntry: number,
  path: ArbTick[],
  hi: ExchangeId,
  lo: ExchangeId,
  slip: number | null
): ArbSimResult | null {
  if (!path.length || !Number.isFinite(netEntry)) return null;
  const slipModeled = typeof slip === 'number' && Number.isFinite(slip);
  const cost = arbCostPct(lo, hi, slipModeled ? slip : null);
  const tp = arbTpTargetPct(netEntry, cost);
  const slLvl = arbSlLevelPct(netEntry);
  const convLvl = arbConvergeLevelPct(netEntry);

  let exit: ArbExit = 'timeout';
  let pnl = -cost;
  for (const t of path) {
    if (!Number.isFinite(t.net)) continue;
    pnl = netEntry - t.net - cost;
    if (t.net >= slLvl) {
      exit = 'sl';
      break;
    }
    if (tp != null && pnl >= tp) {
      exit = 'tp';
      break;
    }
    if (t.net <= convLvl) {
      exit = 'converged';
      break;
    }
  }
  /* Округление ДО сравнения, а не после: записанное число обязано определять тот
     вердикт, который к нему приписан. Округлить на выходе — значит опубликовать
     значение, соседнее с тем, по которому принято решение. */
  const pnlR = r3(pnl);
  return { exit, pnlPct: pnlR, grossPct: r3(pnl + cost), costPct: r3(cost), win: pnlR > 0, slipModeled };
}
