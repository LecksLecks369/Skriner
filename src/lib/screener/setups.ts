/* Сетапы движения: ПРОБОЙ (до того, как он случился), ЁРШ (пила/ложные пробои)
   и РАЗДАЧА/НАБОР (памп-дамп с распределением позиции крупным участником).

   Все три считаются по 1м-свечам, доступным для каждой строки скана, и уточняются
   лентой/ликвидациями там, где они есть (топ-40 по скору). Каждый сетап пишется
   в историю паттернов и получает измеренный исход — детектор без win-rate это
   украшение, а не сигнал. */

import { atr } from './score';
import type { BreakoutSetup, Candle, ChopState, DistributionState, TapeStats } from './types';

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

/* Округление величин, по которым принимаются решения. Округлять надо ОДИН раз и
   до сравнения с порогом, а не при выдаче: иначе наружу уходит одно число, а
   вердикт вынесен по другому, и запись перестаёт быть воспроизводимой. */
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/* ============================ ПРОБОЙ ============================ */

/* Дальше этого расстояния до уровня сигнал не выдаётся.

   История порога — предупреждение о том, как легко подогнать отсечку под шум.
   Первый замер (50 исходов, 6 из них дальше 0.5 ATR) дал за порогом −0.284% с
   интервалом целиком ниже нуля, и порог встал на 0.5. На 74 исходах этот результат
   НЕ ВОСПРОИЗВЁЛСЯ: по чистым crypto (без стейблов, датированных фьючерсов и обёрток
   на акции) полосы дают ≤0.2 → −0.076 (n=18), 0.2-0.4 → +0.016 (n=20),
   0.4-0.5 → +0.051 (n=9), 0.5-0.8 → −0.076 (n=11), >0.8 → −0.051 (n=4).
   Кумулятивное матожидание почти не зависит от отсечки: ≤0.3 → −0.018, ≤0.5 → −0.013,
   ≤0.8 → −0.025 — то есть верхняя граница решает мало, и 0.8 добавляет ~20% сигналов
   ценой ~0.012 п.п.

   Что на этих данных выглядит важнее верхней границы: САМАЯ БЛИЗКАЯ полоса ≤0.2 ATR —
   худшая из крупных. Нижнюю границу не ставлю, пока она не подтвердится на большей
   выборке: именно так и появился нереплицировавшийся порог 0.5. */
export const BREAKOUT_MAX_DIST_ATR = 0.8;

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
  if (distAtr > BREAKOUT_MAX_DIST_ATR && !fired) {
    reasons.push('до уровня ' + distAtr.toFixed(2) + ' ATR — дальше ' + BREAKOUT_MAX_DIST_ATR + ' ATR сигнал не выдаётся');
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
    ready: !fired && distAtr <= BREAKOUT_MAX_DIST_ATR,
    reasons,
  };
}

/* Готовность к пробою, с которой сигнал считается состоявшимся: один порог и для
   записи в историю паттернов, и для SSE-алерта. Разные пороги означали бы, что
   win-rate во вкладке «История» посчитан не по тем сигналам, которые приходят в алертах.
   Живёт здесь, а не в scan.ts, чтобы подпись популяции в истории читала ту же константу,
   которой гейтится запись: patterns.ts импортирует setups.ts, а scan.ts — нет (цикл). */
export const BREAKOUT_ALERT = 60;

/* ============================= ЁРШ ============================== */

const CHOP_BARS = 30;

/* Порог эффективности, ниже которого движение считается пилой. Тот же порог служит
   критерием исхода: сигнал проверяется той же величиной на будущем окне, а не
   подставной полосой цены со своим свободным параметром.

   Порог и шкала взяты ИЗ ИЗМЕРЕННОГО РАСПРЕДЕЛЕНИЯ, а не на глаз. Замер 2026-09-10:
   2308 произвольных 30-минутных окон по 68 crypto-перпам из популяции скана (1м-свечи
   Bybit) дали квантили ER p5=0.012, p10=0.025, p15=0.040, p25=0.068, p50=0.151,
   p90=0.359. Прежний порог 0.32 стоял между p75 и p90: его проходили 85.8% окон, то
   есть «ёрш» горел почти всегда и не сообщал ничего — 95 исходов дали 81.1%
   подтверждений против базовой частоты 86.9%, ниже подбрасывания монеты.

   p10 означает «пилит сильнее, чем девять получасов из десяти». Заодно это делает
   критерий исхода различающим: базовая частота выполнения упала с 86% до 10%, и
   превышение над ней теперь видно. Передвигать порог следует по этим же квантилям.

   ПОПРАВКА 2026-09-11. «p10» — свойство той выборки, а не порога: на 463 бессрочных
   OKX (13243 окна) этот же 0.025 проходят 6.71% окон, то есть сегодня он ближе к p7.
   Квантиль дрейфует вместе с популяцией, поэтому подписывать порог квантилем можно
   только рядом с датой и выборкой замера. Сама доля срабатываний считается прогоном
   scripts/measure-chop-baseline.mjs, а не выводится из этого комментария. */
export const CHOP_ER_P05 = 0.012;
export const CHOP_ER_P50 = 0.151;
export const CHOP_ER_MAX = 0.025; // p10 на замере 2026-09-10 (Bybit); p7 на 2026-09-11 (OKX)
/* Контроль, с которым обязан сравниваться win-rate ерша.
   ВАЖНО, ЧТО ЭТО ЗА ВЕЛИЧИНА. Здесь стояла prevalence — доля ПРОИЗВОЛЬНЫХ окон,
   в которых эффективность и так ниже порога. Она отвечает не на тот вопрос. Ёрш
   утверждает условное: «пила есть сейчас → она сохранится ближайшие 30 минут».
   Контролем для такого утверждения служит persistence — доля окон с пилой ПОСЛЕ
   окна с пилой. Это разные числа, и заменять одно другим нельзя ни в какую сторону.

   Замер 2026-09-11, 463 бессрочных OKX, 13243 непересекающихся окна по 30 минут:
   prevalence 6.71% (888/13243), persistence 8.38% (71/847), 95% ДИ 6.70..10.44%.
   То есть пила слегка ЗАЛИПАЕТ: отбор по ней поднимает вероятность следующего окна
   с пилой примерно в 1.25 раза, и нижняя граница интервала едва отделяется от
   prevalence. Направление тут не выводится из общих соображений — на первом, втором
   замере (n=241) получилось 4.1%, то есть «возврат к среднему», и это оказалось
   шумом малой выборки: 4.1% лежит вне интервала полного замера. Так что число
   берётся ТОЛЬКО из прогона, а не из рассуждения о том, куда должна двигаться
   статистика.

   Прежние 0.1 были неверны дважды: не та величина (prevalence вместо persistence)
   и устаревшее измерение — снято однажды на 68 перпах Bybit. Против них записанные
   4.5% читались как «достоверно хуже монетки» (z ≈ −2.1); против настоящего контроля
   это z ≈ −1.6, то есть неотличимо от отсутствия информации. Разница между «вредный»
   и «бесполезный» целиком держалась на выборе контрольного числа.

   Получено прогоном scripts/measure-chop-baseline.mjs — не вписывать руками: это
   ИЗМЕРЕНИЕ со сроком годности, привязанное к популяции и дате, а не свойство
   формулы. Меняете CHOP_ER_MAX или популяцию скана — перезапустите скрипт. */
export const CHOP_PERSIST_BASE_RATE = 0.084; // okx, 463 симв., n=847, 2026-09-11

/* Порога по скору в условии срабатывания больше нет, и это не ослабление фильтра.
   Замер на тех же 13243 окнах: гейт ER ≤ 0.025 проходили 6.71% окон, гейт «скор ≥ 55» —
   0.66%, то есть связывающим условием был скор, вдесятеро жёстче того, что написано
   в описании популяции, и стоял он на p99.4 собственной шкалы (p50 = 9, p90 = 35,
   p99 = 53). При этом 35 баллов из нужных 55 — это 35·clamp((p50−er)/(p50−p05)),
   функция того самого er, который уже проверен первым условием: пройдя гейт ER, строка
   автоматически получала 31.7–35 балла, а остальные слагаемые при потолке 65 давали
   на живых данных около 17. Конъюнкция была одним условием, посчитанным дважды, плюс
   остаток с низким потолком — и на контроле не добавляла ничего: persistence при полном
   условии 8.77% (5/57) против 8.38% (71/847) у одного ER, интервалы перекрываются
   целиком. Пятнадцатикратная потеря выборки ради прибавки, которую этой же выборкой
   не измерить. Скор остаётся как ПОКАЗАТЕЛЬ (шкала не тронута, чтобы записанные
   chopScore были сравнимы с историей), но решение принимает величина, по которой
   определены и порог, и исход, и контроль. */

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
  /* Округляется здесь, а не в return: дальше от этого же числа считаются и скор,
     и isErsh, и то, что уходит в журнал. Пока решение принималось по неокруглённому
     er, а наружу отдавалось округлённое до 0.001, запись могла показывать er = 0.025
     при isErsh = false — проверено, 1 случай на 538 окон. Читатель, сверяющий
     записанное значение с порогом, получал вердикт, противоположный вердикту
     детектора, и никакой признак в записи на это не указывал. Четвёртый знак берётся
     не для точности: 1e-4 — это 0.4% от порога 0.025, то есть сдвиг границы заведомо
     меньше разрешения самой величины, зато вердикт теперь выводится из записи. */
  const er = r4(clamp(net / path));

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
  /* Шкала ER привязана к квантилям популяции: полный балл у нижних 5% пилящих окон,
     ноль — от медианы. Прежняя шкала (полный балл при er≤0.05, ноль при er≥0.35)
     раздавала частичный балл почти всему распределению, поэтому скор «ершистости»
     был высоким у совершенно обычных монет. */
  score += 35 * clamp((CHOP_ER_P50 - er) / (CHOP_ER_P50 - CHOP_ER_P05));
  score += 25 * clamp((flips - 0.35) / 0.35);
  score += 20 * clamp((wickRatio - 0.3) / 0.4);
  score += bothSides ? 10 : 0;
  // много сделок без перевеса стороны — характерная лента пилы
  if (tape && tape.tradesPerMin >= 30 && Math.abs(tape.aggression) <= 0.12) score += 10;

  const final = Math.round(clamp(score, 0, 100));
  return {
    score: final,
    er, // уже округлён выше — ровно то число, по которому вынесен isErsh
    flips: Math.round(flips * 100) / 100,
    wickRatio: Math.round(wickRatio * 100) / 100,
    bothSides,
    /* Одно условие, ровно то, по которому считается и порог, и исход, и контроль.
       Скор в решении не участвует — см. комментарий у CHOP_PERSIST_BASE_RATE. */
    isErsh: er <= CHOP_ER_MAX,
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
