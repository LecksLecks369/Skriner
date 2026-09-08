/* Viability пассивного маркет-мейкинга: стоит ли на этой монете вообще стоять лимитками.

   Зачем отдельно от остальных метрик: неликвид интересен не тем, что там большой
   межбиржевой разрыв (его там как раз нет — замер по полосе $0.3–20M дал медиану
   нетто-спреда около нуля), а тем, что нативный спред стакана широкий, а конкуренция
   в очереди слабая. Это другая экономика: доход идёт не с разрыва между площадками,
   а со спреда собственной книги, и платится мейкерская комиссия, а не тейкерская.

   Модель намеренно простая, и все её допущения — здесь, а не в голове:

   1. Обе ноги исполняются мейкером: берём спред книги минус ДВЕ мейкерские комиссии.
      Если результат ≤ 0, дальше считать нечего — пассивный ММ на этой площадке
      убыточен при любом обороте (на биржах с нулевым мейкером это условие мягче).
   2. Размер котировки — это ВВОДНАЯ (сколько капитала ставим на сторону), а не
      производная от глубины. Первая версия брала долю очереди, и на неликвиде выходили
      котировки по $100–450: модель занижала размер ровно там, где он ограничен не
      конкуренцией, а нашим желанием — в тонкой книге маркет-мейкер сам является
      книгой, а не долей чужой очереди. Ограничение сверху остаётся одно, реальное:
      max-позиция, которую стакан переварит при выходе.
   3. Доля потока, которая достаётся нам, равна нашей доле в очереди — S/(S+глубина).
      При размере много больше глубины она стремится к единице: весь поток идёт через
      нашу котировку, и оборот упирается уже в размер позиции, а не в конкуренцию.
      Приоритет по времени не моделируется, поэтому число — верхняя оценка и подписано
      как валовое.
   4. Риск не вычитается из дохода выдуманным коэффициентом, а выносится отдельным
      условием: спред, который мы забираем за круг, должен превышать движение цены
      за время этого круга. Ниже единицы котировку сносит обычным шумом быстрее,
      чем она успевает заработать, и величина дохода уже не имеет значения. */

import type { ExchangeId, MmViability } from './types';

export interface MmInput {
  ex: ExchangeId;
  bookSpreadPct: number; // нативный спред стакана, %
  makerFee: number; // доля, напр. 0.0002 = 0.02%
  depth10Usd: number; // объём заявок в ±0.1% от mid — очередь у верха книги
  flowUsdPerMin: number; // оборот ленты, USD в минуту
  sigma1mPct: number | null; // типичное движение цены за минуту, %
  maxPosUsd: number | null; // сколько книга тянет со слипейджем ≤0.3%
  quoteSizeUsd?: number; // сколько ставим на сторону; по умолчанию MM_DEFAULT_QUOTE_USD
}

/** Размер котировки на сторону по умолчанию, USD — вводная модели, а не свойство рынка */
export const MM_DEFAULT_QUOTE_USD = 2_000;

export function computeMm(inp: MmInput): MmViability | null {
  if (!(inp.bookSpreadPct > 0) || !(inp.depth10Usd > 0) || !(inp.flowUsdPerMin > 0)) return null;

  const spreadBps = inp.bookSpreadPct * 100;
  const spreadNetBps = spreadBps - 2 * inp.makerFee * 10_000;

  /* Хотим поставить столько-то, но не больше, чем стакан переварит на выходе:
     позиция, из которой нельзя выйти без удара по цене, — не котировка, а ловушка. */
  const want = inp.quoteSizeUsd && inp.quoteSizeUsd > 0 ? inp.quoteSizeUsd : MM_DEFAULT_QUOTE_USD;
  const cap = inp.maxPosUsd != null && inp.maxPosUsd > 0 ? inp.maxPosUsd : Infinity;
  const quoteSizeUsd = Math.min(want, cap);
  if (!(quoteSizeUsd > 0)) return null;

  /* Доля потока по доле в очереди; круг — две ноги, поэтому объёма нужно вдвое больше размера */
  const fillShare = quoteSizeUsd / (inp.depth10Usd + quoteSizeUsd);
  const roundTripsPerHour = (inp.flowUsdPerMin * 60 * fillShare) / (2 * quoteSizeUsd);
  const holdMin = roundTripsPerHour > 0 ? 60 / roundTripsPerHour : null;

  /* Движение цены за время круга: σ за минуту, масштабированная корнем из времени.
     Сравнение со спредом за круг и есть условие жизнеспособности. */
  const moveOverHoldPct = inp.sigma1mPct != null && holdMin != null ? inp.sigma1mPct * Math.sqrt(holdMin) : null;
  const volRatio = moveOverHoldPct != null && moveOverHoldPct > 0 ? spreadNetBps / 100 / moveOverHoldPct : null;

  const grossUsdPerHour = spreadNetBps > 0 ? roundTripsPerHour * quoteSizeUsd * (spreadNetBps / 10_000) : 0;

  const viable = spreadNetBps > 0 && volRatio != null && volRatio > 1;

  /* Скор: доход относительно размера котировки (сколько % от выставленного капитала в час),
     помноженный на запас по риску. Без запаса (volRatio ≤ 1) скор обнуляется — доход,
     который съедается шумом раньше, чем зарабатывается, не является доходом. */
  const yieldPctPerHour = quoteSizeUsd > 0 && grossUsdPerHour != null ? (grossUsdPerHour / quoteSizeUsd) * 100 : 0;
  const risk = volRatio == null ? 0 : Math.max(0, Math.min(1, (volRatio - 1) / 2));
  const score = Math.round(Math.max(0, Math.min(100, Math.min(100, yieldPctPerHour * 20) * risk)));

  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    ex: inp.ex,
    spreadBps: r2(spreadBps),
    spreadNetBps: r2(spreadNetBps),
    quoteSizeUsd: Math.round(quoteSizeUsd),
    roundTripsPerHour: r2(roundTripsPerHour),
    holdMin: holdMin != null ? r2(holdMin) : null,
    volRatio: volRatio != null ? r2(volRatio) : null,
    grossUsdPerHour: grossUsdPerHour != null ? r2(grossUsdPerHour) : null,
    score,
    viable,
  };
}
