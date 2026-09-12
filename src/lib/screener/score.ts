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
  /* Нулевая дисперсия — это «разброс не измерен», а не «отклонение огромно».
     Здесь стояло `curV > mean * 3 ? 3 : 0`: выдуманное значение, проходящее любой
     порог. Худший случай — монета с нулевым историческим объёмом и одной сделкой:
     mean = 0, условие curV > 0 верно, z = 3, и блок объёма получает полные 15 из 15
     баллов, а затвор свипа (volZ >= 1.5) открывается. То есть замороженный или
     мёртвый фид печатал максимальный объёмный импульс — ровно там, где алертить
     нельзя, и ровно в той популяции (неликвид), ради которой скринер и написан.
     Та же дисциплина уже действовала в spreadZScore (store.ts) с этим же
     обоснованием; на соседнее выражение она перенесена не была. Из двух ошибок
     обратима только одна: пропущенный всплеск на ровном объёме дождётся следующих
     свечей, когда дисперсия появится, а сделка по залипшему фиду не видна никак. */
  if (std < 1e-9) return null;
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
    /* ATR берётся по свечам ДО i, а не включая i. Со slice(0, i + 1) свеча под
       проверкой входила в собственную базу: её тень раздувала ATR, а wickAtr =
       upper / a занижался ровно на самых крупных тенях — то есть детектор
       недосрабатывал именно там, где снятие ликвидности было самым сильным.
       Измеряемая единица не может входить в свой контроль (та же правка уже была
       сделана для spreadZScore, где текущий спред попадал в свою историю). */
    const a = atr(candles.slice(0, i));
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
  /* Запускался ли свечной детектор свипа. Отличает «свипа не было» (измеренный ноль)
     от «свечей не было» (блок не прочитан) — в сумме это одно число и разные факты.
     Не передан — берётся наличие natrPct: он из тех же свечей. */
  candlesOk?: boolean;
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

/* Версия выражения скора. Скор нормируется по ДОСТУПНОМУ весу, и это другая
   шкала, чем сумма слагаемых: числа до и после несравнимы. Снимки для
   бэктеста и оптимизатора носят версию рядом со скором, чтобы порог по скору не
   применялся к точкам, посчитанным другой шкалой. */
export const SCORE_VERSION = 2;

/* Веса блоков. Одна таблица: и на расчёт, и на знаменатель покрытия — иначе
   «максимум 100» и фактический максимум расходятся молча. */
const W = { vol: 20, oi: 20, sweep: 15, volume: 15, spread: 10, z: 6, cov: 4, funding: 10 } as const;
const W_TOTAL = Object.values(W).reduce((a, b) => a + b, 0);

/* Пол покрытия. Нормировка на доступный вес снимает штраф за непрочитанные
   блоки, но без пола она же позволяет монете с одним измеренным блоком дойти до 100:
   «8 из 10 доступных» превратилось бы в 80 при покрытии 10%. Поэтому знаменатель не
   опускается ниже этой доли — непрочитанное до пола считается заработавшим ноль.
   Смысл: не предполагать ничего там, где ничего не измерено, но и не позволять обрывку
   данных говорить за целое. */
const COVERAGE_FLOOR = 0.6;

export interface ScoreResult {
  /* 0-100, доля ДОСТУПНОГО веса (со скидкой на пол покрытия).
     Раньше это была сумма слагаемых, в которой отсутствующий вход давал 0 — а ноль
     в сумме это не нейтральность, а голос против, поданный свидетелем, который не
     явился. Следствия были два. Шкала становилась недостижимой: на 3606 записанных
     сигналах при номинальном максимуме 100 наблюдался максимум 84, а у детектора
     «киты» — 43, то есть его сигнал не мог попасть в верхние полосы никогда.
     И дефицит был односторонним: монета с меньшим покрытием данных ранжировалась
     ниже монеты с тем же измеренным содержанием, но полным покрытием — то есть скор
     измерял доступность данных, а не свойства монеты. */
  score: number;
  parts: Record<string, number>;
  /** Доля веса, чьи входы удалось прочитать: 1 = все блоки измерены */
  coverage: number;
  /** Блоки, входы которых отсутствовали — не «равны нулю», а не прочитаны */
  missing: string[];
  version: number;
}

/**
 * Композитный скор 0-100 с мультибиржевым блоком.
 *
 * Нормируется по ДОСТУПНОМУ весу: блок, вход которого отсутствует, исключается из
 * знаменателя, а не засчитывается нулём. Разница между «измерено и равно нулю» и
 * «не измерено» здесь принципиальна — в сумме это одно число и противоположные
 * факты. Отсутствие свипа при прочитанных свечах — измеренный ноль (свипа не было)
 * и остаётся в знаменателе; отсутствие свечей вообще — непрочитанный блок и из
 * знаменателя уходит. Поэтому свечной блок спрашивает про candlesOk, а не про то,
 * пуст ли sweep.
 */
export function computeScore(inp: ScoreInput): ScoreResult {
  const parts: Record<string, number> = {};
  let available = 0;
  const missing: string[] = [];
  /** Блок прочитан: его вес идёт в знаменатель, а заработанное — в числитель */
  const read = (name: keyof typeof W, ok: boolean, earned: number) => {
    if (ok) {
      available += W[name];
      /* Заработанное ОБРЕЗАЕТСЯ диапазоном [0; вес]. Таблица весов — это и есть
         объявленный диапазон блока, и выражение, выходящее за него, спорит с ней.
         Практический случай: при перекрывающихся книгах нетто-спред отрицателен, и
         блок спреда давал −1.7 балла. С нормировкой по доступному весу это уже не
         косметика: сумма может уйти ниже нуля, и «скор 0-100» напечатает
         отрицательное число. Отрицательный нетто-спред — измеренный факт «арбитража
         нет», он и стоит ноль баллов; сама величина и её знак живут в netSpreadPct,
         где их и читают, а вычитать её ещё и из скора значило бы учесть дважды. */
      parts[name] = Math.min(W[name], Math.max(0, earned));
    } else {
      missing.push(name);
      parts[name] = 0;
    }
  };

  // 1. Волатильность (max 20): оптимум 0.25–1.2% NATR
  const x = inp.natrPct;
  read(
    'vol',
    x != null,
    x == null
      ? 0
      : x < 0.1
        ? 0
        : x < 0.25
          ? (x / 0.25) * 14
          : x <= 1.2
            ? 14 + ((x - 0.25) / 0.95) * 6
            : Math.max(6, 20 - (x - 1.2) * 9)
  );

  // 2. OI-импульс (max 20)
  const d15 = inp.dOiPct15m;
  const d1h = inp.dOiPct1h;
  let oi = 0;
  if (d15 != null || d1h != null) {
    const a15 = d15 != null ? Math.abs(d15) : 0;
    const a1h = d1h != null ? Math.abs(d1h) : 0;
    oi += Math.min(10, (a15 / 0.8) * 10); // 0.8% за 15м — максимум
    oi += Math.min(6, (a1h / 2) * 6); // 2% за час — максимум
    if (d15 != null && d1h != null && Math.sign(d15) === Math.sign(d1h) && a15 > 0.15) oi += 4;
  }
  read('oi', d15 != null || d1h != null, Math.min(20, oi));

  /* 3. Снятие ликвидности (max 15): свежесть решает.
     Блок читается, если свечи были: тогда «свипа нет» — измеренный факт. Без свечей
     детектор не запускался, и нулём это записывать нельзя. candlesOk не передан —
     откат на «свечи были, если известна волатильность»: она из тех же свечей. */
  const candlesOk = inp.candlesOk ?? inp.natrPct != null;
  let sweep = 0;
  if (inp.sweep) {
    const sg = inp.sweep;
    const fresh = sg.ageMin <= 5 ? 1 : sg.ageMin <= 15 ? 0.7 : sg.ageMin <= 30 ? 0.4 : 0.15;
    const strength = Math.min(1, (sg.wickAtr - 1.5) / 1.5) * 0.6 + Math.min(1, (sg.volMult - 2) / 4) * 0.4;
    sweep = 15 * fresh * Math.max(0.3, strength);
  }
  read('sweep', candlesOk, sweep);

  // 4. Объёмный импульс (max 15)
  read('volume', inp.volZ != null, inp.volZ != null ? Math.min(15, Math.max(0, ((inp.volZ - 0.5) / 2.5) * 15)) : 0);

  /* 5. Мультибиржевой блок: разрыв, аномальность и покрытие бирж — ТРИ разных входа
     с разной доступностью, поэтому и три отдельных блока. Пока они складывались в
     одно слагаемое, отсутствие стакана гасило и премию за число бирж. */
  if (inp.slipRoundTripPct === undefined) {
    // стакан не запрашивался (монета вне deep-топа) — спред по котировкам
    read('spread', inp.netSpreadPct != null, inp.netSpreadPct != null ? Math.min(10, (inp.netSpreadPct / 0.6) * 10) : 0);
  } else {
    /* Стакан запрашивался: null означает, что книга не набрала объём даже на
       минимальный бюджет. Это ИЗМЕРЕНИЕ («спред неисполним»), а не отсутствие
       данных, поэтому блок читается и зарабатывает ноль — иначе самые тонкие книги
       выпадали бы из знаменателя и выглядели бы лучше, чем они есть. */
    const netExec = execSpreadPct(inp.netSpreadPct, inp.slipRoundTripPct);
    read(
      'spread',
      true,
      netExec != null ? Math.min(10, (Math.max(0, netExec) / 0.6) * 10) * sizeViability(inp.maxPosUsd) : 0
    );
  }
  read('z', inp.zScore != null, inp.zScore != null && inp.zScore > 0 ? Math.min(6, (inp.zScore / 3) * 6) : 0);
  read('cov', true, Math.min(4, Math.max(0, (inp.coverage - 1) * 1.3))); // 2 биржи=1.3, 4 биржи=3.9

  // 6. Фандинг-экстрем (max 10)
  read(
    'funding',
    inp.fundingAbs != null,
    inp.fundingAbs != null ? Math.min(10, Math.max(0, ((Math.abs(inp.fundingAbs) - 0.0003) / 0.0005) * 10)) : 0
  );

  const earned = Object.values(parts).reduce((a, b) => a + b, 0);
  const coverage = available / W_TOTAL;
  const denom = Math.max(available, COVERAGE_FLOOR * W_TOTAL);
  const score = denom > 0 ? Math.round(Math.min(100, Math.max(0, (earned / denom) * 100))) : 0;
  return {
    score,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    coverage: Math.round(coverage * 100) / 100,
    missing,
    version: SCORE_VERSION,
  };
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

