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
  /* Сколько РЕАЛЬНОГО ВРЕМЕНИ покрывает окно оценки, часов. null = метки времени не
     переданы.

     Окно задано ЧИСЛОМ исходов (EDGE_WINDOW), а не длиной интервала, и это значит,
     что у разных детекторов один и тот же вердикт описывает совершенно разные
     промежутки: у ерша 570 сигналов в сутки, его 60 исходов — это около двух часов
     рынка; у китов 9 сигналов в сутки, их 60 исходов — почти неделя. Счётчик,
     ограниченный количеством, не есть временное окно: он даёт активному субъекту
     двухчасовую историю, а тихому — недельную, и все значения при этом верны, а вот
     сравнимость — нет. Выключение и реабилитация поэтому реагируют у детекторов с
     разной скоростью, и это свойство их частоты срабатывания, а не их качества.
     Число публикуется рядом с вердиктом, чтобы «n=60» читалось вместе с тем, за
     какой период оно набрано. */
  windowHours: number | null;
  /* Слои выборки, если исходы паттерна посчитаны НЕ ОДНИМ выражением. Пусто, когда
     выражение одно. См. combineStrata: заголовочные числа берутся из крупнейшего
     слоя, а не из объединения, потому что объединение — не оценка ни одной из
     величин. */
  strata?: EdgeStratum[];
}

/**
 * Один слой выборки: исходы, посчитанные ОДНИМ выражением.
 *
 * Зачем слои. У двух детекторов исходы приходят по двум разным методикам под одним
 * именем: у спреда издержки круга считаются со слипейджем, когда стакан на момент
 * сигнала измерен, и только по комиссиям, когда нет (второе — верхняя граница, и
 * замер показал разрыв в 1.3 п.п. на сделку и противоположные знаки); у направленных
 * цель выводится из NATR монеты, а при неизвестной волатильности берётся запасная
 * фиксированная — «ход 0.4%» у тихой монеты это шум, у громкой недостижимая цель.
 * Доля каждой методики уже показывалась (byTarget, costSlipModeled), но вердикт,
 * который ВЫКЛЮЧАЕТ детектор, продолжал считаться по объединению. Показать состав
 * смеси и оценивать смесь — разные вещи: документированное смешивание остаётся
 * смешиванием.
 */
export interface EdgeStratum {
  key: string;
  /** Человекочитаемое имя методики — рендерится, а не набирается рядом с ней */
  label: string;
  n: number;
  nUnits: number | null;
  expectancyPct: number | null;
  ciLoPct: number | null;
  ciHiPct: number | null;
  winRate: number | null;
  verdict: EdgeVerdict;
  /** За какой промежуток реального времени набран этот слой, часов */
  windowHours: number | null;
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

/** Длина покрытого окна в часах: разница между первой и последней меткой */
function spanHours(ts?: number[]): number | null {
  if (!ts || ts.length < 2) return null;
  const lo = Math.min(...ts);
  const hi = Math.max(...ts);
  return Math.round(((hi - lo) / 3_600_000) * 10) / 10;
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
/**
 * base — контроль как ОЦЕНКА: точка и её 95% интервал. Границы обязательны, потому
 * что контроль сам измерен на конечной выборке: сравнение интервала детектора с
 * точкой контроля даёт вердикт «выше базовой» при интервалах, которые полностью
 * перекрываются. Если границы не известны, передайте их равными точке — тогда
 * поведение прежнее, и это видно в коде вызова, а не спрятано в умолчании.
 */
export function computeRateEdge(
  hits: boolean[],
  base: { rate: number; lo: number; hi: number },
  groups?: string[],
  tsList?: number[]
): EdgeReport {
  const baseRate = base.rate;
  const nTotal = hits.length;
  const win = hits.slice(-EDGE_WINDOW);
  const n = win.length;
  const winGroups = groups && groups.length === nTotal ? groups.slice(-EDGE_WINDOW) : undefined;
  const windowHours = spanHours(tsList && tsList.length === nTotal ? tsList.slice(-EDGE_WINDOW) : undefined);
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
    windowHours,
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

  const rSpan = windowHours != null ? `, за ${windowHours} ч` : '';
  const rUnits = (out.nUnits != null && out.nUnits < n ? `, независимых символов ${out.nUnits}` : '') + rSpan;
  if (n < EDGE_MIN_N) return out;
  const baseLoPct = Math.round(base.lo * 1000) / 10;
  const baseHiPct = Math.round(base.hi * 1000) / 10;
  /* Сравниваются ИНТЕРВАЛЫ: чтобы объявить детектор хуже контроля, его верхняя
     граница должна уйти ниже НИЖНЕЙ границы контроля; чтобы объявить лучше — нижняя
     граница выше ВЕРХНЕЙ границы контроля. Во всех промежуточных случаях интервалы
     перекрываются, и это «не измерено», а не «не хуже». */
  if (wr && wr.hi < base.lo) {
    out.verdict = 'negative';
    out.muted = true;
    out.reason = `${Math.round((wins / n) * 100)}% попаданий (интервал до ${Math.round(wr.hi * 100)}%, n=${n}${rUnits}) — ниже всего интервала базовой частоты ${basePct}% [${baseLoPct}%; ${baseHiPct}%]: сигнал хуже её отсутствия`;
    return out;
  }
  if (wr && wr.lo > base.hi) {
    out.verdict = 'positive';
    out.reason = `${Math.round((wins / n) * 100)}% попаданий (интервал от ${Math.round(wr.lo * 100)}%, n=${n}${rUnits}) — выше всего интервала базовой частоты ${basePct}% [${baseLoPct}%; ${baseHiPct}%]`;
    return out;
  }
  out.reason = wr
    ? `${Math.round((wins / n) * 100)}% попаданий, интервал [${Math.round(wr.lo * 100)}%; ${Math.round(wr.hi * 100)}%] пересекается с интервалом базовой частоты ${basePct}% [${baseLoPct}%; ${baseHiPct}%] при n=${n}${rUnits} — эдж не доказан`
    : `n=${n}`;
  out.verdict = 'inconclusive';
  return out;
}

export function computeEdge(pnls: number[], groups?: string[], tsList?: number[]): EdgeReport {
  const nTotal = pnls.length;
  const win = pnls.slice(-EDGE_WINDOW);
  const n = win.length;
  const winGroups = groups && groups.length === nTotal ? groups.slice(-EDGE_WINDOW) : undefined;
  const nUnits = winGroups ? new Set(winGroups).size : null;
  /* Тот же самый slice, что у данных: длина окна режется здесь и только здесь,
     иначе подпись и выборка разъедутся при первом изменении EDGE_WINDOW. */
  const windowHours = spanHours(tsList && tsList.length === nTotal ? tsList.slice(-EDGE_WINDOW) : undefined);
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
    windowHours,
  };
  if (!n) return base;

  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const wins = win.filter((p) => p > 0);
  const losses = win.filter((p) => p <= 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = losses.reduce((s, p) => s + Math.abs(p), 0);
  const exp = mean(win);
  const ci = bootstrapMeanCI(win, 0.95, winGroups);
  /* Интервал доли — кластерный, когда единицы известны, и только потом Уилсон.
     Здесь стоял построчный wilsonInterval, хотя в этой же функции матожидание уже
     ресэмплилось по символам, а соседняя computeRateEdge делает кластерный интервал
     доли с докстрингом «разные единицы измерения не освобождают от одного и того же
     требования к независимости наблюдений». Правило было записано у соседа и не
     применено здесь: строки одного символа внутри горизонта — повторные замеры
     одного события, и построчный интервал уже истинного ровно в меру дублирования. */
  const wrGroups = winGroups ? bootstrapRateCI(win.map((p) => p > 0), winGroups) : null;
  const wr = wrGroups ?? wilsonInterval(wins.length, n);

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
  /* Окно набрано за РАЗНОЕ время у разных детекторов (см. windowHours), поэтому
     промежуток едет в той же строке, что и n: «n=60» без него сравнимо только с
     самим собой. */
  const span = windowHours != null ? `, за ${windowHours} ч` : '';
  const units = (nUnits != null && nUnits < n ? `, независимых символов ${nUnits}` : '') + span;

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

/**
 * Оценка паттерна, исходы которого посчитаны НЕСКОЛЬКИМИ выражениями.
 *
 * Правило: объединение слоёв не оценивается. Объединённое среднее — не оценка ни
 * одной из величин, а средневзвешенное по доле, которую задаёт доступность данных
 * (измерен ли был стакан, была ли известна волатильность), то есть переменная, не
 * связанная с самим сигналом. Замер на живых данных: у спреда слой с полными
 * издержками давал −1.067% на сделку при 0 побед из 16, слой-верхняя-граница
 * +0.144% при 45 победах из 60; объединение печатало −0.064% и вердикт
 * «не доказано».
 *
 * ДВА ВИДА СЛОЁВ, и путать их нельзя.
 *
 * `ordered: true` — слои упорядочены по ПОЛНОТЕ, groups[0] самый полный, остальные
 * его верхние границы (у спреда: издержки со слипейджем против одних комиссий —
 * слипейдж не вычтен, значит настоящий результат не лучше). Тогда:
 *   • заголовок берётся из САМОГО ПОЛНОГО слоя, даже если он меньше. Верхняя
 *     граница не является оценкой величины — её нельзя ставить в заголовок, когда
 *     пропущенный член крупнее самого результата (замер: ~1.2 п.п. пропущено при
 *     результате 0.14 п.п., то есть в восемь раз);
 *   • отрицательная ВЕРХНЯЯ ГРАНИЦА — доказательство убытка, и она выключает
 *     детектор, не дожидаясь полной модели;
 *   • 'positive' требуется от полного слоя: положительная верхняя граница не
 *     доказывает ничего.
 *
 * `ordered: false` — слои несравнимы по полноте, это просто разные величины
 * (у направленных: цель от NATR монеты против запасной фиксированной — «ход 0.4%»
 * у тихой монеты недостижим, у громкой берётся шумом; ни одна не граница другой).
 * Тогда заголовок — крупнейший слой, а 'positive' снимается, если другой слой
 * противоречит знаком.
 *
 * Выключение в обоих случаях: любой слой с достаточным n и доказанным минусом.
 * Слои — одна и та же сделка, посчитанная по-разному, а не разные стратегии, и
 * доказанный убыток в одной методике не отменяется нехваткой данных в другой.
 */
export function combineStrata(
  groups: ReadonlyArray<{ key: string; label: string; pnl: number[]; sym: string[]; ts: number[] }>,
  opts: { ordered: boolean } = { ordered: false }
): EdgeReport {
  const nonEmpty = groups.filter((g) => g.pnl.length > 0);
  if (!nonEmpty.length) return computeEdge([], []);
  /* Один слой — никакой смеси нет, и добавлять разбивку не нужно: пустое поле
     strata и есть утверждение «выражение одно». */
  if (nonEmpty.length === 1) return computeEdge(nonEmpty[0].pnl, nonEmpty[0].sym, nonEmpty[0].ts);

  const reports = nonEmpty.map((g) => ({ g, r: computeEdge(g.pnl, g.sym, g.ts) }));
  const strata: EdgeStratum[] = reports.map(({ g, r }) => ({
    key: g.key,
    label: g.label,
    n: r.n,
    nUnits: r.nUnits,
    expectancyPct: r.expectancyPct,
    ciLoPct: r.ciLoPct,
    ciHiPct: r.ciHiPct,
    winRate: r.winRate,
    verdict: r.verdict,
    windowHours: r.windowHours,
  }));

  /* Упорядоченные слои: заголовок — самый полный (первый), а не самый крупный.
     Неупорядоченные: самый крупный, потому что «полнее» между ними не определено. */
  const primary = opts.ordered ? reports[0] : [...reports].sort((a, b) => b.r.n - a.r.n)[0];
  const negative = reports.filter(({ r }) => r.verdict === 'negative');
  const out: EdgeReport = { ...primary.r, strata };

  const others = strata
    .filter((x) => x.key !== primary.g.key)
    .map((x) => `${x.label}: ${x.expectancyPct ?? '—'}% при n=${x.n}`)
    .join('; ');
  const head = `Заголовок — ${opts.ordered ? 'самый полный' : 'крупнейший'} слой «${primary.g.label}» (n=${primary.r.n}) из ${strata.length}; остальные — ${others}`;

  if (negative.length) {
    out.verdict = 'negative';
    out.muted = true;
    const n0 = negative[0];
    const viaBound = opts.ordered && n0.g.key !== primary.g.key;
    out.reason =
      `слой «${n0.g.label}» доказанно убыточен: интервал целиком ниже нуля ` +
      `(до ${n0.r.ciHiPct}% на сделку, n=${n0.r.n})` +
      (viaBound ? ' — это ВЕРХНЯЯ граница результата, значит настоящий результат не лучше' : '') +
      `. ${head}`;
    return out;
  }
  if (out.verdict === 'positive') {
    const contradicts = strata.some(
      (x) => x.key !== primary.g.key && x.expectancyPct != null && x.expectancyPct < 0
    );
    if (contradicts) {
      out.verdict = 'inconclusive';
      out.muted = false;
      out.reason = `слой «${primary.g.label}» положителен (n=${primary.r.n}), но другой слой даёт отрицательное среднее. Две методики расходятся в знаке, эдж не доказан. ${head}`;
      return out;
    }
  }
  out.reason = `${primary.r.reason}. ${head}`;
  return out;
}
