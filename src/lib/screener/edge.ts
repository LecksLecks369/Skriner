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
  /* Сколько среди них НЕЗАВИСИМЫХ единиц (разных символов): n считает строки,
     а строки одного символа — повторные замеры одного события. null = единицы не
     переданы, интервал построен по строкам и потому оптимистичен. */
  nUnits: number | null;
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

/**
 * Перцентильный бутстрэп-интервал среднего.
 *
 * groups — метка независимой единицы для каждого наблюдения (у нас символ). Если
 * она задана, ресэмплятся ЕДИНИЦЫ ЦЕЛИКОМ, а не строки: строки одного символа
 * коррелированы, и ресэмплинг по строкам считает каждую за независимое
 * наблюдение. Замер по истории спреда: 133 исхода пришли с 36 символов, 38% из
 * них стартовали внутри окна предыдущего сигнала того же символа, а один символ
 * дал 70% всего P&L. Интервал по строкам выходил уже истинного ровно в меру
 * дублирования — и вердикт, открывающий алерты, стоял на нём.
 */
export function bootstrapMeanCI(xs: number[], level = 0.95, groups?: string[]): { lo: number; hi: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  const rand = rng(seedOf(xs));
  const means = new Array<number>(BOOTSTRAP_B);

  /* Кластерный бутстрэп: единица ресэмплинга — символ. Единиц меньше двух —
     интервал по ним не построить, честнее вернуть построчный, чем не вернуть
     ничего: он оптимистичен, но это единственное, что данные позволяют. */
  const clusters: number[][] = [];
  if (groups && groups.length === n) {
    const by = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const g = groups[i];
      const cur = by.get(g);
      if (cur) cur.push(xs[i]);
      else by.set(g, [xs[i]]);
    }
    if (by.size >= 2) clusters.push(...by.values());
  }

  if (clusters.length >= 2) {
    const K = clusters.length;
    for (let b = 0; b < BOOTSTRAP_B; b++) {
      let s = 0;
      let cnt = 0;
      for (let i = 0; i < K; i++) {
        const c = clusters[(rand() * K) | 0];
        for (const v of c) {
          s += v;
          cnt++;
        }
      }
      means[b] = cnt ? s / cnt : 0;
    }
  } else {
    for (let b = 0; b < BOOTSTRAP_B; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += xs[(rand() * n) | 0];
      means[b] = s / n;
    }
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  const lo = means[Math.floor(alpha * BOOTSTRAP_B)];
  const hi = means[Math.min(BOOTSTRAP_B - 1, Math.ceil((1 - alpha) * BOOTSTRAP_B) - 1)];
  return { lo, hi };
}

/**
 * Кластерный интервал для ДОЛИ: ресэмплятся символы целиком, а не строки.
 *
 * Зачем отдельно от wilsonInterval. Уилсон предполагает независимые испытания
 * Бернулли. У детектора, который срабатывает на одном символе несколько раз внутри
 * горизонта оценки, строки одного символа — повторные замеры одного события, и
 * интервал сужается ровно в меру дублирования. Для матожидания это уже было учтено
 * (bootstrapMeanCI с группами), а для детекторов, у которых исход — попадание, а не
 * P&L, — нет: их затвор стоял на построчном Уилсоне. Разные единицы измерения не
 * освобождают от одного и того же требования к независимости наблюдений.
 *
 * Групп меньше двух — возвращается null, и вызывающий честнее откатится на Уилсона,
 * чем построит интервал по одной единице.
 */
export function bootstrapRateCI(
  hits: boolean[],
  groups: string[],
  level = 0.95
): { lo: number; hi: number } | null {
  const n = hits.length;
  if (n < 2 || groups.length !== n) return null;
  const by = new Map<string, boolean[]>();
  for (let i = 0; i < n; i++) {
    const cur = by.get(groups[i]);
    if (cur) cur.push(hits[i]);
    else by.set(groups[i], [hits[i]]);
  }
  if (by.size < 2) return null;
  const clusters = [...by.values()];
  const K = clusters.length;
  const rand = rng(seedOf(hits.map((h) => (h ? 1 : 0))));
  const rates = new Array<number>(BOOTSTRAP_B);
  for (let b = 0; b < BOOTSTRAP_B; b++) {
    let hit = 0;
    let cnt = 0;
    for (let i = 0; i < K; i++) {
      const c = clusters[(rand() * K) | 0];
      for (const v of c) {
        if (v) hit++;
        cnt++;
      }
    }
    rates[b] = cnt ? hit / cnt : 0;
  }
  rates.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return {
    lo: rates[Math.floor(alpha * BOOTSTRAP_B)],
    hi: rates[Math.min(BOOTSTRAP_B - 1, Math.ceil((1 - alpha) * BOOTSTRAP_B) - 1)],
  };
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
/**
 * Отчёт по эджу для паттерна, у которого исход — попадание/промах, а не P&L.
 * Такому паттерну нельзя приписать матожидание: он не предлагает сделку, поэтому
 * «прибыли» у него нет и выдумывать её нельзя. Но затвор ему нужен ровно так же —
 * просто в его собственных единицах, и мерить его надо ПРОТИВ БАЗОВОЙ ЧАСТОТЫ.
 *
 * baseRate — доля произвольных окон популяции, в которых исход выполняется сам собой.
 * Без неё win-rate неинтерпретируем: 10% попаданий при базовой частоте 10% — это ноль
 * информации, а не слабый результат.
 *
 *   выборка меньше EDGE_MIN_N          → 'insufficient';
 *   весь интервал Уилсона ниже базовой → 'negative', паттерн выключается;
 *   весь интервал выше базовой         → 'positive';
 *   базовая внутри интервала           → 'inconclusive'.
 *
 * hits — исходы В ХРОНОЛОГИЧЕСКОМ ПОРЯДКЕ; окно то же, что у computeEdge.
 * groups — символ каждого исхода: независимая единица наблюдения. Передан — интервал
 * строится ресэмплингом символов, как у матожидания; не передан или единиц меньше
 * двух — откат на Уилсона по строкам, и это отражается в nUnits (null).
 */
export function computeRateEdge(hits: boolean[], baseRate: number, groups?: string[]): EdgeReport {
  const nTotal = hits.length;
  const win = hits.slice(-EDGE_WINDOW);
  const n = win.length;
  const winGroups = groups && groups.length === nTotal ? groups.slice(-EDGE_WINDOW) : undefined;
  const pct = (v: number) => Math.round(v * 1000) / 1000;
  const basePct = Math.round(baseRate * 1000) / 10;
  const out: EdgeReport = {
    n,
    nTotal,
    nUnits: winGroups ? new Set(winGroups).size : null,
    expectancyPct: null, // не определено: сделки нет
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
  if (!n) return out;

  const wins = win.filter(Boolean).length;
  /* Кластерный интервал, когда единицы известны; иначе построчный Уилсон. Порядок
     важен: построчный интервал уже истинного, а затвор открывается и закрывается
     именно по его границам. */
  const wr = (winGroups ? bootstrapRateCI(win, winGroups) : null) ?? wilsonInterval(wins, n);
  out.winRate = pct(wins / n);
  out.winLoPct = wr ? pct(wr.lo) : null;
  out.winHiPct = wr ? pct(wr.hi) : null;

  const rUnits = out.nUnits != null && out.nUnits < n ? `, независимых символов ${out.nUnits}` : '';
  if (n < EDGE_MIN_N) return out;
  if (wr && wr.hi < baseRate) {
    out.verdict = 'negative';
    out.muted = true;
    out.reason = `${Math.round((wins / n) * 100)}% попаданий (интервал до ${Math.round(wr.hi * 100)}%, n=${n}${rUnits}) — ниже базовой частоты ${basePct}%: сигнал хуже её отсутствия`;
    return out;
  }
  if (wr && wr.lo > baseRate) {
    out.verdict = 'positive';
    out.reason = `${Math.round((wins / n) * 100)}% попаданий (интервал от ${Math.round(wr.lo * 100)}%, n=${n}${rUnits}) — выше базовой частоты ${basePct}%`;
    return out;
  }
  out.reason = wr
    ? `${Math.round((wins / n) * 100)}% попаданий, интервал [${Math.round(wr.lo * 100)}%; ${Math.round(wr.hi * 100)}%] накрывает базовую частоту ${basePct}% при n=${n}${rUnits} — эдж не доказан`
    : `n=${n}`;
  out.verdict = 'inconclusive';
  return out;
}

export function computeEdge(pnls: number[], groups?: string[]): EdgeReport {
  const nTotal = pnls.length;
  const win = pnls.slice(-EDGE_WINDOW);
  const n = win.length;
  const winGroups = groups && groups.length === nTotal ? groups.slice(-EDGE_WINDOW) : undefined;
  const nUnits = winGroups ? new Set(winGroups).size : null;
  const base: EdgeReport = {
    n,
    nTotal,
    nUnits,
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
  const ci = bootstrapMeanCI(win, 0.95, winGroups);
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

  /* n — число строк, nUnits — число независимых символов за ними. Когда второе
     заметно меньше первого, интервал построен по кластерам, и читатель должен
     видеть, на скольких единицах он на самом деле стоит. */
  const units = nUnits != null && nUnits < n ? `, независимых символов ${nUnits}` : '';

  if (n < EDGE_MIN_N) {
    out.verdict = 'insufficient';
    out.reason = `нужно ${EDGE_MIN_N} исходов, есть ${n}`;
    return out;
  }
  if (ci && ci.hi < 0) {
    out.verdict = 'negative';
    out.muted = true;
    out.reason = `весь интервал ниже нуля (до ${r3(ci.hi)}% на сделку, n=${n}${units}) — паттерн не окупает издержки`;
    return out;
  }
  if (ci && ci.lo > 0) {
    out.verdict = 'positive';
    out.reason = `интервал целиком выше нуля (от ${r3(ci.lo)}% на сделку, n=${n}${units})`;
    return out;
  }
  out.verdict = 'inconclusive';
  out.reason = ci
    ? `ноль внутри интервала [${r3(ci.lo)}%; ${r3(ci.hi)}%] при n=${n}${units} — эдж не доказан`
    : `n=${n}`;
  return out;
}
