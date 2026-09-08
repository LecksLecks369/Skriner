/* Оценка эджа паттерна: матожидание с доверительным интервалом + вердикт.

   Зачем интервал, а не одно число: на 8 сделках среднее +0.11% и среднее −0.11% — это
   один и тот же результат «ничего не известно». Без интервала любая цифра в карточке
   читается как факт, и паттерн с 11 наблюдениями выглядит так же убедительно, как
   паттерн с 300. Поэтому вердикт даётся не по знаку среднего, а по тому, лежит ли
   ноль внутри интервала.

   Бутстрэп, а не t-интервал: распределение результатов не колоколообразное — это
   почти два пика (тейк и стоп) с редким таймаутом посередине, и на выборках в
   несколько десятков нормальное приближение даёт слишком узкий интервал. Ресэмплинг
   ничего не предполагает о форме распределения.

   Генератор псевдослучайных чисел детерминированный: отчёт, который прыгает при каждом
   обновлении страницы, невозможно ни проверить, ни обсудить. Один и тот же набор
   исходов всегда даёт один и тот же интервал. */

/** Минимум разрешённых исходов, до которого вердикт не выносится вообще */
export const EDGE_MIN_N = 20;
/** Окно последних исходов, по которому считается эдж: паттерн должен уметь восстановиться */
export const EDGE_WINDOW = 60;
/** Число ресэмплов бутстрэпа */
const BOOTSTRAP_B = 2000;

export type EdgeVerdict = 'insufficient' | 'negative' | 'inconclusive' | 'positive';

export interface EdgeReport {
  n: number; // сколько исходов вошло в оценку (окно)
  nTotal: number; // сколько разрешённых исходов есть всего
  expectancyPct: number | null; // среднее чистое P&L на сделку, %
  ciLoPct: number | null; // 95% доверительный интервал матожидания
  ciHiPct: number | null;
  winRate: number | null;
  winLoPct: number | null; // интервал Уилсона для доли выигрышей
  winHiPct: number | null;
  profitFactor: number | null; // сумма прибылей / сумма убытков
  sumPnlPct: number | null;
  verdict: EdgeVerdict;
  muted: boolean; // паттерн выключён из алертов
  reason: string; // человекочитаемое обоснование вердикта
}

/** mulberry32 — детерминированный PRNG: одинаковый seed даёт одинаковую последовательность */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed из самих данных: отчёт воспроизводим и не зависит от времени вызова */
function seedOf(xs: number[]): number {
  let h = 2166136261;
  for (const x of xs) {
    const v = Math.round(x * 1000);
    h = Math.imul(h ^ (v & 0xff), 16777619);
    h = Math.imul(h ^ ((v >> 8) & 0xff), 16777619);
    h = Math.imul(h ^ ((v >> 16) & 0xff), 16777619);
  }
  return (h >>> 0) || 1;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Перцентильный бутстрэп-интервал среднего */
export function bootstrapMeanCI(xs: number[], level = 0.95): { lo: number; hi: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  const rand = rng(seedOf(xs));
  const means = new Array<number>(BOOTSTRAP_B);
  for (let b = 0; b < BOOTSTRAP_B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[(rand() * n) | 0];
    means[b] = s / n;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  const lo = means[Math.floor(alpha * BOOTSTRAP_B)];
  const hi = means[Math.min(BOOTSTRAP_B - 1, Math.ceil((1 - alpha) * BOOTSTRAP_B) - 1)];
  return { lo, hi };
}

/** Интервал Уилсона для доли: на малых n честнее нормального приближения */
export function wilsonInterval(wins: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const halfWidth = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - halfWidth) / d), hi: Math.min(1, (centre + halfWidth) / d) };
}

/**
 * Отчёт по эджу для одного паттерна.
 * pnls — чистые результаты сделок В ХРОНОЛОГИЧЕСКОМ ПОРЯДКЕ (последние — свежайшие).
 *
 * Вердикт стоит на интервале, а не на знаке среднего:
 *   выборка меньше EDGE_MIN_N        → 'insufficient', никаких утверждений;
 *   весь интервал ниже нуля          → 'negative', паттерн выключается;
 *   весь интервал выше нуля          → 'positive';
 *   ноль внутри интервала            → 'inconclusive'.
 *
 * Выключение — функция от окна последних EDGE_WINDOW исходов и больше ни от чего:
 * состояние нигде не хранится, поэтому паттерн включится обратно сам, когда плохие
 * исходы выйдут из окна. Запись сигналов при этом НЕ прекращается — иначе выключенный
 * паттерн лишился бы данных, по которым только и мог бы реабилитироваться.
 */
export function computeEdge(pnls: number[]): EdgeReport {
  const nTotal = pnls.length;
  const win = pnls.slice(-EDGE_WINDOW);
  const n = win.length;
  const base: EdgeReport = {
    n,
    nTotal,
    expectancyPct: null,
    ciLoPct: null,
    ciHiPct: null,
    winRate: null,
    winLoPct: null,
    winHiPct: null,
    profitFactor: null,
    sumPnlPct: null,
    verdict: 'insufficient',
    muted: false,
    reason: `нужно ${EDGE_MIN_N} исходов, есть ${n}`,
  };
  if (!n) return base;

  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const wins = win.filter((p) => p > 0);
  const losses = win.filter((p) => p <= 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = losses.reduce((s, p) => s + Math.abs(p), 0);
  const exp = mean(win);
  const ci = bootstrapMeanCI(win);
  const wr = wilsonInterval(wins.length, n);

  const out: EdgeReport = {
    ...base,
    expectancyPct: r3(exp),
    ciLoPct: ci ? r3(ci.lo) : null,
    ciHiPct: ci ? r3(ci.hi) : null,
    winRate: Math.round((wins.length / n) * 1000) / 1000,
    winLoPct: wr ? Math.round(wr.lo * 1000) / 1000 : null,
    winHiPct: wr ? Math.round(wr.hi * 1000) / 1000 : null,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? null : 0,
    sumPnlPct: r3(win.reduce((s, p) => s + p, 0)),
  };

  if (n < EDGE_MIN_N) {
    out.verdict = 'insufficient';
    out.reason = `нужно ${EDGE_MIN_N} исходов, есть ${n}`;
    return out;
  }
  if (ci && ci.hi < 0) {
    out.verdict = 'negative';
    out.muted = true;
    out.reason = `весь интервал ниже нуля (до ${r3(ci.hi)}% на сделку, n=${n}) — паттерн не окупает издержки`;
    return out;
  }
  if (ci && ci.lo > 0) {
    out.verdict = 'positive';
    out.reason = `интервал целиком выше нуля (от ${r3(ci.lo)}% на сделку, n=${n})`;
    return out;
  }
  out.verdict = 'inconclusive';
  out.reason = ci ? `ноль внутри интервала [${r3(ci.lo)}%; ${r3(ci.hi)}%] при n=${n} — эдж не доказан` : `n=${n}`;
  return out;
}
