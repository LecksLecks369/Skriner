/* История паттернов: единый журнал сигналов всех типов + отложенная оценка исходов.

   Направленные паттерны (robot/sweep/whale/funding) оцениваются симуляцией выхода:
   сделка идёт по пути цены от входа, и фиксируется то, что случилось ПЕРВЫМ —
   тейк (+WIN_THR) или стоп (−STOP_THR); не задето ни то ни другое за 30 минут —
   выход по рынку на краю окна. Если в одной свече задеты обе границы, порядок внутри
   свечи неизвестен, поэтому засчитывается стоп (консервативно).

   Так делать обязательно: оценка «выиграл, если MFE дошёл до порога» считала выигрышем
   сделку, которая сначала сходила в минус на 4% и закрылась в убытке — просадка
   в метрику не входила вовсе, и win-rate завышался.

   spread (арбитраж) — тоже симуляция сделки, а не факт схлопывания разрыва: P&L круга
   (спред входа − спред выхода − комиссии обеих ног дважды). «Разрыв сошёлся вдвое» само по себе
   не значит прибыли — круг регулярно стоит дороже разрыва; такой выход помечается 'converged'.

   Оценка исходов: для направленных паттернов и спреда — сначала серии в памяти (до ~9ч),
   затем 1м-клайны биржи сигнала. Для «ерша» порядок обратный, клайны первыми: его исход
   определён на поминутных закрытиях, а серия пишется с шагом скана и
   систематически занижает пройденный путь. Если оценить нечем — сигнал ждёт, но только пока его окно
   исхода внутри покрытия клайнов (KLINES_COVER_MS); старше 6 часов — помечается истёкшим
   (в win-rate не идёт). Очередь дооценки идёт не по возрасту, а по остатку
   оцениваемости — иначе просроченный префикс съедает батч и свежие сигналы протухают
   не дождавшись. */

import fs from 'fs';
import path from 'path';
import type { Candle, ExchangeId } from './types';
import { fetchKlines, KLINES_BARS } from './exchanges';
import { seriesStore } from './store';
import { BREAKOUT_ALERT, CHOP_ER_MAX, CHOP_PERSIST_BASE_RATE } from './setups';
import {
  arbConvergeLevelPct,
  arbCostPct,
  execSpreadPct,
  arbSlLevelPct,
  arbTpTargetPct,
  directionalCostPct,
  feePairPct,
} from './costs';
import { computeEdge, computeRateEdge, wilsonInterval, type EdgeReport } from './edge';

export type PatternKind = 'spread' | 'robot' | 'sweep' | 'whale' | 'funding' | 'breakout' | 'distribution' | 'chop';

export interface PatternSignal {
  key: string;
  ts: number;
  symbol: string;
  pattern: PatternKind;
  dir: 'long' | 'short' | 'arb'; // arb = барицентрический спред, направление не важно
  price: number; // цена входа (медиана / mid)
  ex: ExchangeId | null; // биржа для докупки клайнов при оценке
  native: string | null;
  /* метрики на момент сигнала */
  netPct?: number | null;
  zScore?: number | null;
  score?: number;
  algoScore?: number;
  illiqScore?: number;
  aggression?: number;
  whaleUsd?: number;
  fundingPct?: number; // % за интервал
  wickAtr?: number;
  volMult?: number;
  /* для spread: пара бирж/цен, чтобы восстановить схлопывание по клайнам */
  hiEx?: ExchangeId;
  loEx?: ExchangeId;
  hiNative?: string;
  loNative?: string;
  hiPrice?: number;
  loPrice?: number;
  spreadPct?: number;
  /* Слипейдж ОДНОГО пересечения обеих книг на момент сигнала, % (из deep-блока).
     Пишется, чтобы исход считался той же моделью издержек, что и бумажная сделка:
     без него из результата вычитались только комиссии, и вердикт по эджу выходил
     положительным ровно за счёт пропущенного члена. Отсутствует у монет вне
     deep-топа и у сигналов, записанных до появления поля. */
  slipRoundTripPct?: number | null;
  /* для сетапов движения */
  setupScore?: number; // готовность пробоя / сила раздачи / ершистость
  level?: number; // уровень пробоя
  distAtr?: number; // расстояние до уровня в ATR на момент сигнала
  distKind?: string; // pump_distribution | dump_absorption
  movePct?: number; // ход, вызвавший сигнал раздачи
  chopScore?: number | null; // ершистость на момент сигнала: проверка, режет ли фильтр ложные пробои
  natrPct?: number | null; // волатильность монеты: без неё нельзя отличить эдж от размаха
  erThr?: number; // для «ерша»: порог эффективности, ниже которого пила считается сохранившейся
  bandPct?: number; // legacy: полуширина диапазона у сигналов до перехода на будущий ER
}

/** Версия методики оценки. Исходы старых версий несравнимы с новыми и при загрузке
    выбрасываются на пересчёт.
    v2: выход симулируется по пути цены (тейк/стоп/таймаут) вместо MFE без просадки.
    v3: из результата вычитаются издержки круга — комиссии тейкером на входе и выходе;
        для спреда впервые считается сам результат сделки, а не факт схлопывания разрыва
        (схлопывание вдвое ничего не говорит о прибыли: круг может стоить дороже разрыва). */
/* v4: путь разрыва считается по КОТИРОВКАМ ТОЙ ЖЕ ПАРЫ, что и вход, и со знаком.
      До v4 ветка серий брала разрыв лучшей пары монеты на каждом тике (пара
      плавала — на LSKUSDT четыре контрагента за 38 минут), а ветка свечей брала
      модуль разности закрытий к середине — три разных выражения под одним именем,
      и winrate расходился 91% против 54.5% в зависимости от того, какая ветка
      сработала. Исходы v≤3 несравнимы с новыми и отбрасываются загрузчиком. */
/* v5: у спреда в издержки круга вошёл слипейдж (arbCostPct вместо arbFeesPct), когда
      стакан на момент сигнала измерен. Исходы v4 считались с одними комиссиями —
      0.179% против 1.04% слипейджа круга на живом замере, — поэтому они несравнимы с
      новыми и отбрасываются загрузчиком. Версия поднята ТОЛЬКО у спреда: остальные
      семь детекторов считаются ровно как раньше, и глобальный бамп выбросил бы их
      историю вместе с вердиктами, которыми они выключены. */
export const OUTCOME_VERSION = 5;

/**
 * Минимальная версия, при которой исход сравним с новыми, ПО ТИПАМ.
 *
 * Версия исхода — свойство ВЫРАЖЕНИЯ, а не системы целиком. В v4 сменился путь
 * только у спреда; направленные паттерны считаются ровно как раньше. Глобальная
 * проверка `v < OUTCOME_VERSION` выбросила бы вместе со спредом историю семи
 * детекторов, которых правка не касалась, — и заодно те самые исходы, по которым
 * робот, фандинг и пробой были ВЫКЛЮЧЕНЫ как убыточные. Замер: бамп обнулил 1054
 * разрешённых исхода, вердикты всех типов стали 'insufficient', и три доказанно
 * отрицательных паттерна снова начали слать алерты.
 *
 * Поэтому порог задаётся per-pattern и поднимается только у того типа, чьё
 * выражение действительно изменилось.
 */
const OUTCOME_MIN_V: Partial<Record<PatternKind, number>> = {
  spread: 5, // издержки круга со слипейджем, а не только комиссии
};
const OUTCOME_MIN_V_DEFAULT = 3;

/** Тип паттерна из ключа исхода (`<pattern>:<symbol>:<ts>`) */
function kindFromKey(key: string): PatternKind | null {
  const k = key.slice(0, key.indexOf(':'));
  return (ALL_KINDS as readonly string[]).includes(k) ? (k as PatternKind) : null;
}

/** 'converged' — разрыв сошёлся, но прибыли после издержек нет; тейком это не считается */
export type ExitReason = 'tp' | 'sl' | 'timeout' | 'converged';

export interface PatternOutcome {
  ts: number; // время оценки
  mfePct: number | null; // макс благоприятное движение % до выхода (в сторону dir)
  maePct: number | null; // макс неблагоприятное движение % до выхода
  movePct: number | null; // движение на краю 30-минутного окна (в сторону dir)
  win: boolean | null; // null = истёк без оценки
  expired?: boolean;
  /* поля симуляции выхода (v2+; для спреда — с v3) */
  v?: number; // версия методики
  exit?: ExitReason; // что сработало первым
  pnlPct?: number | null; // ЧИСТЫЙ результат сделки: ход по правилу выхода минус издержки круга, %
  pnlGrossPct?: number | null; // тот же результат до вычета издержек, %
  costPct?: number; // издержки круга, вычтенные из результата, %
  costSlipModeled?: boolean; // false = проскальзывание не учтено (только комиссии), результат завышен
  erAfter?: number | null; // «ёрш»: эффективность хода на будущем окне — та же величина, что и в детекторе
  erThrUsed?: number; // порог, по которому вынесен вердикт: исходы с другим порогом несравнимы
  /* Каким путём цены посчитан исход. Это НЕ диагностика, а параметр методики: серии в
     памяти хранят одну цену за тик (h = l = c), поэтому тейк или стоп, задетые между
     сэмплами, там не видны и сделка уходит в timeout; клайны несут настоящие high/low.
     Пока ветка не записана, обе попадают в один win-rate и расслоить его нечем, а
     пропорция смеси задаётся доступностью данных — величиной, которая коррелирует с
     ликвидностью и аптаймом. У исходов, записанных до появления поля, оно пустое. */
  src?: 'series' | 'klines';
}

/* ---------------- Хранилище ---------------- */

const DATA_DIR = path.join(process.cwd(), 'data');
const PATTERNS_FILE = path.join(DATA_DIR, 'pattern_history.jsonl');
const OUTCOMES_FILE = path.join(DATA_DIR, 'pattern_outcomes.json');
const MAX_SIGNALS = 3000;
/* Горизонт оценки исхода. Экспортируется, потому что он же задаёт нижнюю границу
   любого кулдауна: сетка, которая перебирает кулдауны короче горизонта, выбирает
   комбинации на перекрывающихся дубликатах одного события. */
export const HORIZON_MS = 30 * 60 * 1000;

/* Задержка входа: путь разрыва читается не с момента сигнала, а на столько позже.
   Смысл — время на то, чтобы поставить обе ноги; без него симуляция засчитывала бы
   схождение, случившееся раньше, чем позиция могла существовать. Величина была
   вписана числом прямо в выражение и нигде не объяснена, поэтому её побочный эффект
   (первые минуты окна невидимы, включая стоп) не был виден ни в подписи популяции,
   ни в отчёте. Теперь она константа и печатается в подписи популяции спреда. */
export const ARB_ENTRY_LAG_MS = 5 * 60_000;

const EXPIRE_MS = 6 * 3600 * 1000;
const RESOLVE_BATCH = 10; // максимум дооценок за вызов (лимит API-нагрузки)

/* Насколько назад видит оценка исхода. Выводится из глубины клайнов, а не задаётся
   своим числом: это одна и та же величина, и разъехаться они не должны. Сигнал
   старше этого окна дооценить нечем — резолвер по этому и решает, кого ставить
   в очередь первым. */
const KLINES_COVER_MS = KLINES_BARS * 60_000;

/* Пороги ЗАПИСИ в журнал. Живут здесь, рядом с WIN_THR, а не в scan.ts, потому что
   порог записи — это граница популяции, по которой считается win-rate, а не деталь
   скана. Подпись под цифрой в «Истории» выводится из этих же констант: подпись,
   переписанная руками, расходится с кодом молча и ровно тогда, когда порог двигают. */
export const RECORD_THR = {
  /** нетто-спред, с которого спред-сигнал попадает в журнал, % */
  spreadNetPct: 0.25,
  /** |ставка фандинга| за интервал */
  fundingAbs: 0.001,
  /** |нетто-поток китов| за окно, $ */
  whaleNetUsd: 300_000,
  /** свип старше этого в журнал не идёт, мин */
  sweepMaxAgeMin: 5,
  /** z-score объёма на свипе */
  sweepMinVolZ: 1.5,
} as const;

/**
 * Порог алерта по z-score: разрыв обязан быть НЕОБЫЧНЫМ для этого символа,
 * а не просто большим в абсолюте.
 *
 * Почему именно z, а не размер разрыва. Разрыв 0.3% на монете, у которой 0.3% —
 * обычное состояние, это не расхождение, а базовая линия: измерять его нечем,
 * пока неизвестно, что для неё норма. Замер по 135 разрешённым исходам, из
 * которых вычеркнут IOSTUSDT (он один давал 70% всего P&L и перекрывал любую
 * группировку):
 *
 *   z отсутствует (истории нет) → n=27, 19 символов, winrate 0.52, мат.ож. −0.053%
 *   z 1..2                      → n=21,  8 символов, winrate 0.81, мат.ож. +0.059%
 *   z ≥ 2                       → n=62, 20 символов, winrate 0.95, мат.ож. +0.176%
 *
 * Худшая группа — не «маленький разрыв», а «не с чем сравнить», и она
 * единственная с отрицательным матожиданием. Размер разрыва так не делит:
 * в полосе 0.8%+ winrate падает до 0.46 при высоком среднем, то есть крупные
 * разрывы — это структурные расхождения вроде IOST и LSK, которые держатся
 * часами и не сходятся вовсе.
 *
 * Порог применяется к АЛЕРТУ, но не к записи: перестав записывать
 * отфильтрованное, система лишилась бы контрольной группы и больше никогда не
 * смогла бы проверить сам фильтр. Поэтому win-rate в «Истории» отдаётся
 * разбитым по этому порогу — см. byAlertGate.
 */
export const SPREAD_ALERT_MIN_Z = 2;

const COOLDOWN_RAW: Record<PatternKind, number> = {
  spread: 10 * 60_000,
  robot: 10 * 60_000,
  sweep: 30 * 60_000,
  whale: 60 * 60_000,
  funding: 60 * 60_000,
  breakout: 20 * 60_000,
  distribution: 30 * 60_000,
  chop: 30 * 60_000,
};

/* Кулдаун повторной записи не может быть КОРОЧЕ горизонта исхода. Иначе одно
   затянувшееся событие пишется как несколько сигналов, чьи окна оценки
   перекрываются: n растёт, число независимых наблюдений — нет. Замер по
   истории спреда: 38% исходов стартовали внутри окна предыдущего сигнала того
   же символа, 49% интервалов между повторами были короче 30 минут, а 133
   исхода пришли всего с 36 символов. Бутстрэп в edge.ts ресэмплил строки как
   независимые, поэтому интервал выходил уже истинного — и вердикт «весь выше
   нуля», открывающий алерты, считался по допущению, которое данные нарушают.

   Хуже того, дубликаты копятся именно на том, что ДЛИТСЯ, — а разрыв, который
   не закрылся, есть контрпример к тезису паттерна. Сигнал, повторно взведённый
   внутри горизонта, — это продолжение открытого, а не новое наблюдение. */
/* Экспортируется, потому что кулдаун — это граница популяции, и поток алертов
   обязан жить по той же, что и запись. Пока у алертов были свои числа (10/15/20
   мин против 30 у записи), карточки robot/breakout/distribution подписывались
   alertScope: 'same' — «алерт по тому же условию», — и это было неверно: на один
   символ алертов выходило втрое больше, чем записей, а win-rate считался по
   записям. */
export const COOLDOWN_MS = Object.fromEntries(
  Object.entries(COOLDOWN_RAW).map(([k, v]) => [k, Math.max(v, HORIZON_MS)]),
) as Record<PatternKind, number>;

/** Подпись кулдауна для описания популяции — из той же константы, что его и применяет */
const cooldownLabel = (k: PatternKind) => `не чаще раза в ${Math.round(COOLDOWN_MS[k] / 60_000)} мин на символ`;

/**
 * Граница популяции для каждого типа: при каком условии сигнал вообще попал в журнал,
 * и совпадает ли это условие с тем, по которому шлётся алерт.
 *
 * Зачем в выдаче: win-rate описывает выборку, а не рынок, и без условия отбора он
 * неинтерпретируем. Отдельно важен alertScope — у спреда порог записи фиксирован
 * (RECORD_THR.spreadNetPct), а порог алерта задаёт пользователь, поэтому цифра в
 * «Истории» посчитана НЕ по тем сигналам, которые до него доехали, и утверждать
 * обратное нельзя. У свипа, китов и фандинга алерта нет вовсе — это только журнал.
 */
export type AlertScope = 'same' | 'differs' | 'none';
export const PATTERN_POPULATION: Record<PatternKind, { population: string; alertScope: AlertScope; alertNote: string }> = {
  spread: {
    population:
      `нетто-спред ≥ ${RECORD_THR.spreadNetPct}% · ${cooldownLabel('spread')} · ` +
      `вход с задержкой ${Math.round(ARB_ENTRY_LAG_MS / 60_000)} мин, издержки круга со слипейджем там, где стакан измерен`,
    alertScope: 'differs',
    alertNote: 'порог алерта задаётся в настройках отдельно — win-rate посчитан по всем записанным сигналам, а не по доехавшим до алерта',
  },
  robot: {
    population: 'алго-паттерн «робот в неликвиде» по стакану и ленте',
    alertScope: 'same',
    alertNote: 'алерт по тому же условию',
  },
  sweep: {
    population: `свип не старше ${RECORD_THR.sweepMaxAgeMin} мин · z объёма ≥ ${RECORD_THR.sweepMinVolZ}`,
    alertScope: 'none',
    alertNote: 'алерта нет — только журнал',
  },
  whale: {
    population: `|нетто-поток китов| ≥ $${(RECORD_THR.whaleNetUsd / 1000).toFixed(0)}k`,
    alertScope: 'none',
    alertNote: 'алерта нет — только журнал',
  },
  funding: {
    population: `|фандинг| ≥ ${(RECORD_THR.fundingAbs * 100).toFixed(2)}% за интервал`,
    alertScope: 'none',
    alertNote: 'алерта нет — только журнал',
  },
  breakout: {
    population: `готовность ≥ ${BREAKOUT_ALERT} и цена ещё не вышла за уровень`,
    alertScope: 'same',
    alertNote: 'один порог на запись и на алерт',
  },
  distribution: {
    population: 'поток разошёлся с ценой (направление раздачи/набора определено)',
    alertScope: 'same',
    alertNote: 'алерт по тому же условию',
  },
  chop: {
    population: `ER ≤ ${CHOP_ER_MAX} · контроль — persistence ${(CHOP_PERSIST_BASE_RATE * 100).toFixed(1)}% (доля окон с пилой ПОСЛЕ окна с пилой, не доля произвольных)`,
    alertScope: 'same',
    alertNote: 'едет пометкой внутри алерта пробоя, по тому же условию',
  },
};

/** Тейк-профит: на сколько % в сторону сигнала сделка считается отработавшей */
export const WIN_THR: Record<PatternKind, number> = {
  spread: 0, // считается по схлопыванию, не по ходу цены
  robot: 0.5,
  sweep: 0.4,
  whale: 0.4,
  funding: 0.4,
  breakout: 0.5,
  distribution: 0.5,
  chop: 0, // ненаправленный: исход — удержался ли диапазон
};

/** Стоп-лосс: просадка, на которой сделка закрывается в минус. 1:1 к тейку —
    при таком R:R win-rate ниже ~50% означает, что паттерн не окупает даже комиссии. */
export const STOP_THR: Record<PatternKind, number> = {
  spread: 0, // не применяется
  robot: 0.5,
  sweep: 0.4,
  whale: 0.4,
  funding: 0.4,
  breakout: 0.5,
  distribution: 0.5,
  chop: 0,
};

/* COOLDOWN_RAW / COOLDOWN_MS объявлены выше, рядом с RECORD_THR: подпись
   популяции в PATTERN_POPULATION строится из той же константы. */

export const PATTERN_META: Record<PatternKind, { icon: string; name: string; hint: string }> = {
  spread: { icon: '🔀', name: 'Спред', hint: 'сделка на разрыве: прибыль после комиссий круга (30 минут)' },
  robot: { icon: '🤖', name: 'Робот вошёл', hint: 'тейк +0.5% раньше стопа −0.5%, минус круг тейкером (30 минут)' },
  sweep: { icon: '🌊', name: 'Свип', hint: 'откат +0.4% раньше стопа −0.4%, минус круг тейкером (30 минут)' },
  whale: { icon: '🐋', name: 'Киты', hint: 'ход по потоку +0.4% раньше стопа −0.4%, минус круг тейкером (30 минут)' },
  funding: { icon: '💸', name: 'Фандинг', hint: 'ход против толпы +0.4% раньше стопа −0.4%, минус круг тейкером (30 минут)' },
  breakout: { icon: '⚡', name: 'Пробой', hint: 'ход в сторону уровня +0.5% раньше стопа −0.5% (30 минут)' },
  distribution: { icon: '📦', name: 'Раздача', hint: 'разворот против пампа/дампа +0.5% раньше стопа −0.5% (30 минут)' },
  chop: {
    icon: '〰',
    name: 'Ёрш',
    /* Подпись собирается из тех же констант, что и решение: переписанная руками,
       она расходится с кодом молча и ровно тогда, когда порог двигают. */
    hint: `пила сохранилась: эффективность хода за следующие 30 минут ≤ ${CHOP_ER_MAX} — контроль ${(CHOP_PERSIST_BASE_RATE * 100).toFixed(1)}% (persistence: как часто пила держится ПОСЛЕ пилы)`,
  },
};

/** Все типы паттернов — из PATTERN_META, чтобы список не расходился при добавлении нового */
const ALL_KINDS = Object.keys(PATTERN_META) as PatternKind[];

interface PatternGlobal {
  __screenerPatterns: {
    signals: PatternSignal[];
    loaded: boolean;
    outcomes: Record<string, PatternOutcome>;
    outcomesLoaded: boolean;
    lastTs: Record<string, number>; // pattern:symbol -> ts последней записи (cooldown)
    resolving: boolean;
  };
}
const g = globalThis as unknown as PatternGlobal;
if (!g.__screenerPatterns) {
  g.__screenerPatterns = { signals: [], loaded: false, outcomes: {}, outcomesLoaded: false, lastTs: {}, resolving: false };
}
const pst = g.__screenerPatterns;

function loadSignals(): PatternSignal[] {
  if (pst.loaded) return pst.signals;
  pst.loaded = true;
  try {
    if (fs.existsSync(PATTERNS_FILE)) {
      const lines = fs.readFileSync(PATTERNS_FILE, 'utf8').trim().split('\n').filter(Boolean);
      pst.signals = lines.slice(-MAX_SIGNALS).map((l) => JSON.parse(l) as PatternSignal);
      for (const s of pst.signals) {
        const k = `${s.pattern}:${s.symbol}`;
        if (!pst.lastTs[k] || s.ts > pst.lastTs[k]) pst.lastTs[k] = s.ts;
      }
    }
  } catch {
    pst.signals = [];
  }
  return pst.signals;
}

function loadOutcomes(): Record<string, PatternOutcome> {
  if (pst.outcomesLoaded) return pst.outcomes;
  pst.outcomesLoaded = true;
  try {
    if (fs.existsSync(OUTCOMES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(OUTCOMES_FILE, 'utf8')) as Record<string, PatternOutcome>;
      /* Исходы старых версий выбрасываем: до v2 «победа» = MFE дошёл до порога без учёта
         просадки, до v3 результат считался без издержек круга, а у спреда его не было вовсе
         (записывался только факт схлопывания разрыва). Складывать такие win/loss с новыми
         нельзя. Сигналы, по которым ещё есть данные, дооценятся заново; остальные истекут. */
      let dropped = 0;
      for (const [key, oc] of Object.entries(raw)) {
        /* «Ёрш» оценивался полосой цены (удержался ли диапазон ±bandPct). Полоса бралась
           от окна детекции, а не от горизонта оценки, и за 30 минут её пробивал обычный
           шум: первая же партия дала 1 из 7 при отклонениях 0.9–1.9% против полосы 0.45%.
           Критерий заменён на ту же величину, которой ёрш и определяется — эффективность
           хода на будущем окне. Исходы без erAfter посчитаны по снятому правилу и
           смешивать их с новыми нельзя. */
        /* Исход ерша сравним только с тем же порогом: порог взят из квантилей популяции
           и при передвижении меняет смысл вердикта, а не его точность. Исходы,
           посчитанные другим порогом (и тем более полосой цены, до erAfter),
           выбрасываются — смешивать их в один win-rate нельзя. */
        const legacyChop =
          key.startsWith('chop:') && oc.win != null && (oc.erAfter == null || oc.erThrUsed !== CHOP_ER_MAX);
        const kind = kindFromKey(key);
        const minV = (kind && OUTCOME_MIN_V[kind]) ?? OUTCOME_MIN_V_DEFAULT;
        const stale = legacyChop || (oc.win != null && (oc.v ?? 1) < minV);
        if (stale) {
          dropped++;
          continue;
        }
        pst.outcomes[key] = oc;
      }
      /* Счётчик отброшенного — не санитарная статистика, а отчёт о дефекте писателя.
         В установившемся режиме он обязан быть нулём: всё, что здесь выбрасывается,
         кто-то выше по течению продолжает производить, и работа делается впустую. */
      if (dropped) {
        console.warn(
          `[patterns] ДЕФЕКТ: исходов несравнимой методики отброшено при загрузке: ${dropped}. ` +
            `В установившемся режиме здесь должен быть 0 — значит, resolvePending всё ещё их пишет.`
        );
      }
    }
  } catch {
    pst.outcomes = {};
  }
  return pst.outcomes;
}

function persistOutcomes() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(OUTCOMES_FILE, JSON.stringify(pst.outcomes));
  } catch {
    /* диск недоступен — исходы в памяти */
  }
}

const QUARANTINE_LOSSES = 4; // столько подряд проигранных исходов подряд включает карантин
const QUARANTINE_MULT = 6; // во столько раз удлиняется кулдаун символа в карантине

/* Некоторые символы дают сигнал снова и снова, и он снова и снова не отрабатывает:
   у токенизированных акций (XOM, MSTR, SOXL) межбиржевой разрыв структурный — разные
   источники цены и часы торгов, — он держится часами и не схлопывается. Такой символ
   забивает журнал и разбавляет статистику. Ловим это не списком тикеров, а по факту:
   подряд проигранные исходы удлиняют кулдаун, первый же выигрыш снимает карантин. */
function quarantined(pattern: PatternKind, symbol: string): boolean {
  const arr = loadSignals();
  const out = loadOutcomes();
  const recent: boolean[] = [];
  for (let i = arr.length - 1; i >= 0 && recent.length < QUARANTINE_LOSSES; i--) {
    const s = arr[i];
    if (s.pattern !== pattern || s.symbol !== symbol) continue;
    const oc = out[s.key];
    if (!oc || oc.win == null) continue; // неоценённые и истёкшие не в счёт
    recent.push(oc.win);
  }
  return recent.length === QUARANTINE_LOSSES && recent.every((w) => !w);
}

/** Записать сигнал паттерна с кулдауном; возвращает true если записан */
export function appendPattern(sig: Omit<PatternSignal, 'key'>): boolean {
  const arr = loadSignals();
  const ck = `${sig.pattern}:${sig.symbol}`;
  const last = pst.lastTs[ck] || 0;
  const cooldown = COOLDOWN_MS[sig.pattern] * (quarantined(sig.pattern, sig.symbol) ? QUARANTINE_MULT : 1);
  if (sig.ts - last < cooldown) return false;
  pst.lastTs[ck] = sig.ts;
  const full: PatternSignal = { ...sig, key: `${sig.pattern}:${sig.symbol}:${sig.ts}` };
  arr.push(full);
  if (arr.length > MAX_SIGNALS) arr.splice(0, arr.length - MAX_SIGNALS);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(PATTERNS_FILE, JSON.stringify(full) + '\n');
  } catch {
    /* диск недоступен — журнал в памяти */
  }
  return true;
}

export function recentPatterns(limit = 120): Array<PatternSignal & { outcome?: PatternOutcome }> {
  const arr = loadSignals();
  const out = loadOutcomes();
  return arr.slice(-limit).reverse().map((s) => ({ ...s, outcome: out[s.key] }));
}

/* ---------------- Оценка исходов ---------------- */

export interface PathPt {
  ts: number;
  h: number;
  l: number;
  c: number;
}

/** Путь цены символа. Если известна биржа сигнала — берём её серию: сделка живёт на одной
    площадке, а слитый путь нескольких бирж пилит цену на величину межбиржевого спреда
    и выбивает стоп там, где на самой бирже его не было. Слияние — только запасной вариант. */
function seriesPath(symbol: string, ex?: ExchangeId | null): PathPt[] {
  const per = seriesStore.getPricePoints(symbol);
  const own = ex ? per[ex] : null;
  const pts: PathPt[] = [];
  if (own && own.length) {
    for (const p of own) pts.push({ ts: p.ts, h: p.v, l: p.v, c: p.v });
  } else {
    for (const arr of Object.values(per)) {
      for (const p of arr) pts.push({ ts: p.ts, h: p.v, l: p.v, c: p.v });
    }
  }
  pts.sort((a, b) => a.ts - b.ts);
  return pts;
}

async function klinesPath(ex: ExchangeId, native: string): Promise<PathPt[] | null> {
  const res = await fetchKlines(ex, native).catch(() => null);
  if (!res || !res.candles.length) return null;
  return res.candles.map((c: Candle) => ({ ts: c.ts, h: c.h, l: c.l, c: c.c }));
}

/** Сделка по пути цены: тейк/стоп/выход по времени. Побеждает то, что задето первым;
    в пределах одной свечи порядок неизвестен, поэтому приоритет у стопа.
    MFE/MAE считаются только до момента выхода — после закрытия сделки движение цены
    к результату отношения не имеет.

    Из результата вычитается круг тейкером (вход + выход) на бирже сигнала: тейк +0.4%
    при круге ~0.11% — это не +0.4%, и «выигрышем» такая сделка считается только если
    остаётся в плюсе после издержек. Проскальзывание здесь не моделируется (стакан на
    момент сигнала не сохранён), поэтому результат остаётся верхней оценкой. */
function evalDirectional(
  path: PathPt[],
  entry: number,
  dir: 'long' | 'short',
  ts0: number,
  tpPct: number,
  slPct: number,
  costPct: number
): PatternOutcome | null {
  const win = path.filter((p) => p.ts >= ts0 && p.ts <= ts0 + HORIZON_MS);
  if (win.length < 8) return null; // покрытия окна нет — не оцениваем
  if (entry <= 0) return null;
  let mfe = 0;
  let mae = 0;
  let exit: ExitReason = 'timeout';
  for (const p of win) {
    const up = ((p.h - entry) / entry) * 100;
    const dn = ((entry - p.l) / entry) * 100;
    const fav = dir === 'long' ? up : dn; // в сторону сигнала
    const adv = dir === 'long' ? dn : up; // против сигнала
    mfe = Math.max(mfe, fav);
    mae = Math.max(mae, adv);
    if (slPct > 0 && adv >= slPct) {
      exit = 'sl';
      break;
    }
    if (tpPct > 0 && fav >= tpPct) {
      exit = 'tp';
      break;
    }
  }
  // ход на краю окна: ближайшая точка к ts0+30м (справочно, независимо от выхода)
  let edge = win[win.length - 1];
  const target = ts0 + HORIZON_MS;
  for (const p of win) if (Math.abs(p.ts - target) < Math.abs(edge.ts - target)) edge = p;
  const move = dir === 'long' ? ((edge.c - entry) / entry) * 100 : ((entry - edge.c) / entry) * 100;
  const gross = exit === 'tp' ? tpPct : exit === 'sl' ? -slPct : move;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  /* Округление ДО сравнения с нулём, а не после. Иначе запись перестаёт быть
     достаточной, чтобы вердикт по ней воспроизвести: в исходе оказывается число,
     соседнее с тем, по которому вердикт вынесен, и противоречие вида pnlPct = 0
     рядом с win = true возникает с частотой, которую задаёт шаг округления, а не
     степень неправоты системы. Та же дисциплина уже соблюдалась в evalChopPersist
     и не была перенесена на соседей. */
  const pnl = r3(gross - costPct);
  return {
    ts: Date.now(),
    mfePct: r3(mfe),
    maePct: r3(mae),
    movePct: r3(move),
    win: pnl > 0,
    v: OUTCOME_VERSION,
    exit,
    pnlPct: pnl,
    pnlGrossPct: r3(gross),
    costPct: r3(costPct),
    costSlipModeled: false,
  };
}

/**
 * Исход «ерша»: цена осталась в пределах ±bandPct от точки сигнала все 30 минут.
 *
 * Ненаправленный паттерн: он не предлагает сделку, он предупреждает, что пробои
 * в ближайший час скорее всего ложные. Поэтому win = диапазон удержался, а pnlPct
 * не считается вовсе — приписывать «прибыль» предупреждению значило бы выдумывать
 * сделку, которой не было.
 */
function minuteCloses(path: PathPt[], ts0: number): number[] {
  const buckets = new Map<number, number>();
  for (const p of path) {
    if (p.ts < ts0 || p.ts > ts0 + HORIZON_MS) continue;
    buckets.set(Math.floor(p.ts / 60_000), p.c); // путь хронологический — в минуте остаётся последняя цена
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

export function evalChopPersist(path: PathPt[], entry: number, ts0: number, erMax: number): PatternOutcome | null {
  const closes = minuteCloses(path, ts0);
  if (closes.length < 12) return null; // на десятке точек эффективность — шум
  let travelled = 0;
  for (let i = 1; i < closes.length; i++) travelled += Math.abs(closes[i] - closes[i - 1]);
  if (travelled <= 0) return null;
  const net = closes[closes.length - 1] - closes[0];
  /* Та же дисциплина, что в detectChop: округлить до сравнения с порогом.
     erAfter и erThrUsed пишутся в исход именно для того, чтобы вердикт можно было
     перепроверить по записи, и это работает, только если win посчитан от того же
     числа, которое записано. OUTCOME_VERSION не поднят намеренно: изменение
     затрагивает лишь значения в пределах 5e-5 от порога, это разрешение округления,
     а не смена методики, и пересчитывать из-за него всю историю нечего. */
  const er = Math.round((Math.abs(net) / travelled) * 10_000) / 10_000;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    ts: Date.now(),
    mfePct: null,
    maePct: entry > 0 ? r3((Math.max(...closes.map((c) => Math.abs(c - entry))) / entry) * 100) : null,
    movePct: entry > 0 ? r3((net / entry) * 100) : null,
    win: er <= erMax,
    v: OUTCOME_VERSION,
    pnlPct: null,
    erAfter: er, // уже округлён выше — то же число, по которому вынесен win
    erThrUsed: erMax,
  };
}

/** Точка пути кросс-спреда: валовый разрыв между биржами сделки, % */
interface SpreadPt {
  ts: number;
  gross: number;
}

/**
 * Симуляция арбитражной сделки по пути спреда — то же правило выхода, что у бумажных сделок.
 *
 * Раньше исход спреда был «разрыв схлопнулся вдвое за 30 минут»: факт о рынке, а не о сделке.
 * Схлопывание вдвое ничего не говорит о прибыли — круг (комиссии обеих ног дважды) регулярно
 * стоит дороже самого разрыва, и такой «выигрыш» оказывается убытком. Поэтому считается P&L:
 * тейк — только выход с прибылью после издержек, схлопывание без прибыли — 'converged'.
 *
 * Проскальзывание не моделируется: стакан на момент сигнала не сохранён. Результат — верхняя
 * оценка, costSlipModeled=false говорит об этом явно.
 */
function simulateSpreadTrade(sig: PatternSignal, path: SpreadPt[]): PatternOutcome | null {
  const { hiEx, loEx } = sig;
  if (!hiEx || !loEx) return null;
  // покупка на loEx (дешёвая сторона), продажа на hiEx
  const feePair = feePairPct(loEx, hiEx);
  const netEntry = sig.netPct ?? (sig.spreadPct != null ? sig.spreadPct - feePair : null);
  if (netEntry == null) return null;
  /* Издержки круга со слипейджем, когда стакан на момент сигнала был измерен.
     Пока вычитались только комиссии, паттерн «спред» выносил вердикт 'positive'
     (+0.155% на сделку, 79% побед) и открывал алерты, тогда как симулятор с полными
     издержками на том же типе сделки давал -2.34% и 3.4% побед на 148 закрытых
     позициях. Пропущенный член был не поправкой, а доминирующим: медиана слипейджа
     одного пересечения книг 0.519% (то есть 1.04% на круг) против 0.179% комиссий и
     0.334% валового результата — то есть знак результата был свойством пропуска, а
     не рынка. costSlipModeled говорит, какой моделью посчитан каждый исход. */
  const slipModeled = typeof sig.slipRoundTripPct === 'number' && Number.isFinite(sig.slipRoundTripPct);
  const cost = arbCostPct(loEx, hiEx, slipModeled ? sig.slipRoundTripPct! : null);
  const from = sig.ts + ARB_ENTRY_LAG_MS;
  const to = sig.ts + HORIZON_MS;
  const win = path.filter((p) => p.ts >= from && p.ts <= to && Number.isFinite(p.gross)).sort((a, b) => a.ts - b.ts);
  if (win.length < 8) return null;

  const tp = arbTpTargetPct(netEntry, cost);
  const slLvl = arbSlLevelPct(netEntry);
  const convLvl = arbConvergeLevelPct(netEntry);
  let exit: ExitReason = 'timeout';
  let mfe = 0;
  let mae = 0;
  let netNow = netEntry;
  let pnl = -cost;
  for (const p of win) {
    netNow = p.gross - feePair;
    pnl = netEntry - netNow - cost;
    mfe = Math.max(mfe, pnl);
    mae = Math.max(mae, -pnl);
    if (netNow >= slLvl) {
      exit = 'sl';
      break;
    }
    if (tp != null && pnl >= tp) {
      exit = 'tp';
      break;
    }
    if (netNow <= convLvl) {
      // разрыв сошёлся, но прибыли нет: держать нечего, и тейком это не является
      exit = 'converged';
      break;
    }
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  // округление ДО сравнения: записанное число обязано определять приписанный к нему вердикт
  const pnlR = r3(pnl);
  return {
    ts: Date.now(),
    mfePct: r3(mfe), // лучший P&L за окно, п.п. (не % схлопывания, как было до v3)
    maePct: r3(mae),
    movePct: r3(netNow - netEntry), // насколько сдвинулся нетто-спред, п.п. (минус = сошёлся)
    win: pnlR > 0,
    v: OUTCOME_VERSION,
    exit,
    pnlPct: pnlR,
    pnlGrossPct: r3(pnlR + cost),
    costPct: r3(cost),
    costSlipModeled: slipModeled,
  };
}

/**
 * Путь спреда из серий в памяти — по КОТИРОВКАМ ИМЕННО ТОЙ ПАРЫ, на которой
 * открывался вход.
 *
 * Раньше здесь стоял `getSpreadHistory(symbol)` — разрыв ЛУЧШЕЙ пары монеты на
 * каждом тике. Лучшая пара плавает: замер по живому логу дал на LSKUSDT четыре
 * разных биржи-контрагента за 38 минут. Путь по такой серии вычитал из входа по
 * одной паре выход по другой, и вдобавок вход выбран как максимум по шести
 * биржам — то есть экстремум, от которого любое следующее измерение отходит к
 * среднему. Winrate 91% на этой ветке против 54.5% на свечах — это и есть цена
 * подмены.
 */
function spreadPathFromSeries(sig: PatternSignal): SpreadPt[] {
  if (!sig.hiEx || !sig.loEx) return [];
  return seriesStore.getPairSpreadPath(sig.symbol, sig.hiEx, sig.loEx);
}

/**
 * Путь спреда из 1м-клайнов обеих бирж: разрыв закрытий как прокси разрыва котировок.
 *
 * Разность ЗНАКОВАЯ и в направлении сделки: продаём на hiEx, покупаем на loEx.
 * Прежний `(max − min)/mid` терял знак, и разошедшийся в обратную сторону разрыв
 * выглядел точно так же, как не схлопнувшийся, — два противоположных состояния
 * рынка под одним числом. Знаменатель — цена ноги покупки, как и на входе, а не
 * середина: середина даёт третье выражение под тем же именем.
 */
async function spreadPathFromKlines(sig: PatternSignal): Promise<SpreadPt[] | null> {
  if (!sig.hiEx || !sig.loEx || !sig.hiNative || !sig.loNative) return null;
  const [hi, lo] = await Promise.all([klinesPath(sig.hiEx, sig.hiNative), klinesPath(sig.loEx, sig.loNative)]);
  if (!hi || !lo) return null;
  const loMap = new Map(lo.map((p) => [Math.round(p.ts / 60_000), p.c]));
  const out: SpreadPt[] = [];
  for (const p of hi) {
    const lc = loMap.get(Math.round(p.ts / 60_000));
    if (!lc || lc <= 0) continue;
    out.push({ ts: p.ts, gross: ((p.c - lc) / lc) * 100 });
  }
  return out.length ? out : null;
}

/** Дооценка нерешённых сигналов (батч до RESOLVE_BATCH за вызов) */
export async function resolvePending(): Promise<number> {
  if (pst.resolving) return 0;
  pst.resolving = true;
  try {
    const arr = loadSignals();
    const out = loadOutcomes();
    const now = Date.now();
    const ripe = arr.filter((s) => !out[s.key] && now - s.ts > HORIZON_MS + 2 * 60_000);

    /* Просроченное закрывается СВЕРХУ и вне батча: сетевой запрос ему не нужен,
       ответ известен заранее. Пока истечение происходило внутри батча, префикс из
       давно просроченных съедал все RESOLVE_BATCH слотов каждый цикл: замер показал
       очередь в 500 сигналов с головой возрастом 2295 минут при EXPIRE_MS = 360. */
    let swept = 0;
    for (const s of ripe) {
      if (now - s.ts > EXPIRE_MS) {
        out[s.key] = { ts: now, mfePct: null, maePct: null, movePct: null, win: null, expired: true };
        swept++;
      }
    }

    /* Очередь упорядочена по ОСТАТКУ ОЦЕНИВАЕМОСТИ, а не по возрасту.
       Исход считается по 1м-клайнам биржи сигнала, а они покрывают только последние
       KLINES_COVER_MS. Сигнал, чьё окно исхода уехало за это покрытие, не оценит уже
       никто — возвращаться к нему бессмысленно. Сортировка по возрастанию ts ставила
       первыми именно таких, и ветка klines за всю историю не дала НИ ОДНОГО исхода
       (bySrc: series 79, klines 0) не потому, что сломана: на сигналах возрастом
       35-49 минут она отдаёт 30 точек из 30 и считает исход штатно. До сигнала просто
       доходили, когда оценивать его было уже нечем. Сначала те, кого ещё можно
       оценить; внутри группы — самые старые, у них остаток окна меньше всех. */
    const stillResolvable = (s: (typeof ripe)[number]) => now - s.ts <= KLINES_COVER_MS;
    const pending = ripe
      .filter((s) => !out[s.key])
      .sort((a, b) => {
        const ra = stillResolvable(a) ? 0 : 1;
        const rb = stillResolvable(b) ? 0 : 1;
        return ra !== rb ? ra - rb : a.ts - b.ts;
      })
      .slice(0, RESOLVE_BATCH);
    let resolved = swept;
    for (const sig of pending) {
      try {
        let oc: PatternOutcome | null = null;
        /* Сигнал, оценить который нечем В ПРИНЦИПЕ (не «пока нечем»): ждать нет смысла,
           помечаем истёкшим сразу, иначе он висит в очереди до EXPIRE_MS и занимает батч. */
        let unresolvable = false;
        /** Пометить исход веткой, которая его посчитала */
        const from = (o: PatternOutcome | null, src: 'series' | 'klines'): PatternOutcome | null => {
          if (o) o.src = src;
          return o;
        };
        if (sig.pattern === 'spread' && (sig.netPct != null || sig.spreadPct != null)) {
          oc = from(simulateSpreadTrade(sig, spreadPathFromSeries(sig)), 'series');
          if (!oc) {
            const path = await spreadPathFromKlines(sig);
            if (path) oc = from(simulateSpreadTrade(sig, path), 'klines');
          }
        } else if (sig.pattern === 'chop') {
          /* Порог берётся ТОЛЬКО из самого сигнала. Подставлять сюда константу нельзя:
             прежний дефолт 0.32 — снятый порог, и исход, посчитанный по нему, загрузчик
             всё равно выбросит как несравнимый. Получался вечный цикл: оценить → записать →
             выбросить при следующей загрузке → оценить снова, и всё это в начале очереди,
             потому что pending сортируется по возрастанию ts. Сигнал, записанный до
             появления параметра, оценке не подлежит — так и помечаем. */
          const erMax = sig.erThr && sig.erThr > 0 ? sig.erThr : null;
          if (erMax == null) {
            unresolvable = true;
          } else {
            /* Клайны ПЕРВЫМИ, серия — запасной вариант, а не наоборот.
               Исход ерша определён на поминутных закрытиях: путь цены суммируется
               по ним, и чем реже взяты точки, тем короче получается путь и тем ВЫШЕ
               выходит ER — смещение одностороннее, прямо против срабатывания. Серия
               пишется с шагом скана (замер по series.json: ~150 с между точками,
               местами 490), то есть даёт 12 точек там, где нужно 30, и ровно на
               границе своего же минимума в evalChopPersist. Клайны дают 30 из 30
               (проверено на сигналах возрастом 35-49 минут). Стоявшая первой серия
               выигрывала у более точного источника просто потому, что возвращала
               непустой результат. */
            if (sig.ex && sig.native) {
              const path = await klinesPath(sig.ex, sig.native);
              if (path) oc = from(evalChopPersist(path, sig.price, sig.ts, erMax), 'klines');
            }
            if (!oc) {
              oc = from(evalChopPersist(seriesPath(sig.symbol, sig.ex), sig.price, sig.ts, erMax), 'series');
            }
          }
        } else if (sig.dir !== 'arb') {
          const tp = WIN_THR[sig.pattern] ?? 0.4;
          const sl = STOP_THR[sig.pattern] ?? tp;
          const cost = directionalCostPct(sig.ex); // круг тейкером на бирже сигнала
          // 1) серии в памяти (покрывают до ~9ч при живом сервере)
          oc = from(evalDirectional(seriesPath(sig.symbol, sig.ex), sig.price, sig.dir, sig.ts, tp, sl, cost), 'series');
          // 2) клайны биржи сигнала (покрывают ~85 минут назад)
          if (!oc && sig.ex && sig.native) {
            const path = await klinesPath(sig.ex, sig.native);
            if (path) oc = from(evalDirectional(path, sig.price, sig.dir, sig.ts, tp, sl, cost), 'klines');
          }
        }
        if (!oc) {
          if (unresolvable || now - sig.ts > EXPIRE_MS) {
            oc = { ts: now, mfePct: null, maePct: null, movePct: null, win: null, expired: true };
          } else {
            continue; // ещё есть шанс дооценить позже
          }
        }
        out[sig.key] = oc;
        resolved++;
      } catch {
        /* пропускаем сигнал, попробуем в следующий раз */
      }
    }
    if (resolved) persistOutcomes();
    return resolved;
  } finally {
    pst.resolving = false;
  }
}

/* ---------------- Агрегация ---------------- */

export interface PatternStat {
  pattern: PatternKind;
  icon: string;
  name: string;
  hint: string;
  total: number; // сигналов всего
  n24h: number;
  resolved: number; // оценено
  wins: number;
  losses: number;
  expired: number;
  waiting: number;
  winRate: number | null; // wins / (wins+losses)
  avgMfeWin: number | null; // средний ход в плюс у выигравших, %
  avgMfeLoss: number | null; // средний ход у проигравших, %
  lastTs: number | null;
  /* результат по правилу выхода — то, ради чего считается статистика (v2+) */
  expectancyPct: number | null; // среднее ЧИСТОЕ pnl на сделку, %; отрицательное = паттерн не окупается
  expectancyGrossPct: number | null; // то же до вычета издержек — видно, сколько съедает круг
  avgCostPct: number | null; // средние издержки круга на сделку, %
  sumPnlPct: number | null; // суммарный pnl по разрешённым сделкам, %
  byExit: { tp: number; sl: number; timeout: number; converged: number }; // чем закрывались сделки
  /* Чем посчитаны исходы. Две ветки — две методики (серии слепы к теням внутри тика),
     поэтому доля здесь читается как состав выборки, а не как справка о работе кэша.
     unknown — исходы, записанные до появления поля. */
  bySrc: { series: number; klines: number; unknown: number };
  /* Условие, при котором сигнал попал в журнал. Win-rate относится ровно к этому
     множеству: без границы отбора он описывает неизвестно что. */
  population: string;
  alertScope: AlertScope;
  alertNote: string;
  avgMaeWin: number | null; // средняя просадка у выигравших, % — цена, которую пришлось пересидеть
  edge: EdgeReport; // матожидание с доверительным интервалом, вердикт и флаг выключения
  /* Затвор алерта против своих контрольных групп. Затвор — КОНЪЮНКЦИЯ, и разбивать
     выборку по одному её члену значит описывать не ту популяцию, что доезжает до
     оператора: пока здесь стоял только z, «passed» показывал 22 сигнала со 100%
     побед, тогда как реальный затвор снимает ещё и всё, что неисполнимо по стакану.
     Поэтому групп четыре, и каждая названа причиной отсева. Порог пользователя
     сюда не входит и входить не может — он задаётся в настройках, поэтому
     alertScope у спреда 'differs'. */
  byAlertGate: {
    minZ: number;
    gates: string[];
    passed: AlertGateCell;
    blockedZ: AlertGateCell; // исполним, но разрыв не аномален для самого символа
    blockedExec: AlertGateCell; // круг дороже разрыва: netExec <= 0
    execUnknown: AlertGateCell; // стакан на момент сигнала не измерен — вердикта нет
  } | null;
}

/** Ячейка разбивки по затвору алерта. pnlN отдельно от n: исход без pnlPct — это
    отсутствие данных, и деление на n разбавляло бы среднее нулями. */
export interface AlertGateCell {
  n: number;
  pnlN: number;
  winRate: number | null;
  expectancyPct: number | null;
}

/** Доли считаются по своим знаменателям, а не по общему n */
function gateCell(a: { n: number; wins: number; pnl: number; pnlN: number }): AlertGateCell {
  return {
    n: a.n,
    pnlN: a.pnlN,
    winRate: a.n ? Math.round((a.wins / a.n) * 1000) / 1000 : null,
    expectancyPct: a.pnlN ? Math.round((a.pnl / a.pnlN) * 1000) / 1000 : null,
  };
}

/* ---------------- Эдж и авто-отключение ---------------- */

/**
 * Чистые результаты сделок по каждому типу, в хронологическом порядке.
 * Только разрешённые исходы: истёкшие (win == null) — это отсутствие данных, а не ноль,
 * и включать их в матожидание нельзя ни как ноль, ни как убыток.
 */
/* Вместе с P&L отдаётся символ каждого исхода: он и есть независимая единица
   наблюдения. Строки одного символа коррелированы (повторные сработки на одном
   затянувшемся разрыве), и интервал в edge.ts обязан ресэмплить символы, а не
   строки, иначе он сужается пропорционально дублированию. */
function pnlSequences(): Record<PatternKind, { pnl: number[]; sym: string[] }> {
  const arr = loadSignals();
  const out = loadOutcomes();
  const seq = Object.fromEntries(
    ALL_KINDS.map((k) => [k, { pnl: [] as number[], sym: [] as string[] }])
  ) as Record<PatternKind, { pnl: number[]; sym: string[] }>;
  for (const s of arr) {
    const oc = out[s.key];
    if (!oc || oc.win == null || oc.pnlPct == null) continue;
    const t = seq[s.pattern];
    if (!t) continue;
    t.pnl.push(oc.pnlPct);
    t.sym.push(s.symbol);
  }
  return seq;
}

/* Паттерны, исход которых — попадание, а не P&L: матожидания у них нет, и затвор по
   доверительному интервалу матожидания для них НЕ РАБОТАЕТ — pnlSequences их пропускает,
   выборка выходит нулевой, вердикт вечно 'insufficient', и худший детектор оказывается
   единственным, кого механизм автоотключения не трогает вовсе. Поэтому у них свой затвор,
   в своих единицах и против своей базовой частоты. Значение — доля произвольных окон
   популяции, в которых исход выполняется сам собой. */
const RATE_BASELINE: Partial<Record<PatternKind, number>> = {
  chop: CHOP_PERSIST_BASE_RATE,
};

/**
 * Попадания по каждому типу из RATE_BASELINE, в хронологическом порядке.
 * Фильтр тот же, что у pnlSequences: истёкшие (win == null) — отсутствие данных, а не промах.
 */
/* Вместе с попаданиями отдаётся символ каждого исхода — по той же причине, что и у
   P&L: строки одного символа коррелированы, и интервал доли обязан ресэмплить
   символы. Пока единицы сюда не передавались, затвор детекторов «попал/не попал»
   стоял на построчном Уилсоне, то есть на более узком интервале, чем данные
   позволяют, — при том что для матожидания это было исправлено. */
function hitSequences(): Record<PatternKind, { hit: boolean[]; sym: string[] }> {
  const arr = loadSignals();
  const out = loadOutcomes();
  const seq = Object.fromEntries(
    ALL_KINDS.map((k) => [k, { hit: [] as boolean[], sym: [] as string[] }])
  ) as Record<PatternKind, { hit: boolean[]; sym: string[] }>;
  for (const s of arr) {
    const oc = out[s.key];
    if (!oc || oc.win == null) continue;
    const t = seq[s.pattern];
    if (!t) continue;
    t.hit.push(oc.win);
    t.sym.push(s.symbol);
  }
  return seq;
}

/* Отчёты пересчитываются не чаще раза в 30с: бутстрэп — 2000 ресэмплов на паттерн,
   а isPatternMuted вызывается на каждом сигнале в потоке алертов. Кэш инвалидируется
   и по времени, и по числу записей, чтобы свежая дооценка исходов не ждала минуту. */
const EDGE_TTL_MS = 30_000;
let edgeCache: { ts: number; signals: number; outcomes: number; v: Record<PatternKind, EdgeReport> } | null = null;

/** Отчёты по эджу всех паттернов */
export function patternEdges(): Record<PatternKind, EdgeReport> {
  const nSig = loadSignals().length;
  const nOut = Object.keys(loadOutcomes()).length;
  if (edgeCache && edgeCache.signals === nSig && edgeCache.outcomes === nOut && Date.now() - edgeCache.ts < EDGE_TTL_MS) {
    return edgeCache.v;
  }
  const seq = pnlSequences();
  const hits = hitSequences();
  const v = Object.fromEntries(
    ALL_KINDS.map((k) => {
      const base = RATE_BASELINE[k];
      return [k, base != null ? computeRateEdge(hits[k].hit, base, hits[k].sym) : computeEdge(seq[k].pnl, seq[k].sym)];
    })
  ) as Record<PatternKind, EdgeReport>;
  edgeCache = { ts: Date.now(), signals: nSig, outcomes: nOut, v };
  return v;
}

/**
 * Выключен ли паттерн: весь доверительный интервал матожидания лежит ниже нуля
 * на окне последних исходов. Состояние нигде не хранится — это чистая функция от
 * журнала, поэтому паттерн включится обратно сам, как только плохие исходы выйдут
 * из окна. Запись сигналов продолжается и у выключенного паттерна: перестав писать,
 * он лишился бы данных, по которым только и может реабилитироваться, — выключение
 * убирает его из алертов, а не из измерения.
 */
export function isPatternMuted(kind: PatternKind): boolean {
  return patternEdges()[kind]?.muted ?? false;
}


/* ===================== ЁРШ КАК ФИЛЬТР ПРОБОЕВ =====================

   Собственное утверждение ерша — не «пила продержится ещё полчаса», а «пробои
   при высокой ершистости ложные». Это разные проверки, и вторая до сих пор не
   считалась, хотя данные для неё пишутся давно: chopScore сохраняется на КАЖДОМ
   сигнале пробоя, а исход пробоя оценивается штатно. Отчёт ниже и есть проверка
   заявления, ради которого детектор существует.

   Контроль здесь — не внешняя константа, а нижняя полоса ершистости на той же
   популяции: обе полосы это пробои, оценённые одним правилом выхода на одном
   горизонте, поэтому разность между ними и есть вклад фильтра.

   Отдельно печатается noScore — пробои, у которых ершистость не записана. Их
   нельзя молча выкинуть: критерий, привязанный к необязательному полю, тихо
   освобождает от проверки всех, у кого поля нет, и покрытие надо видеть цифрой. */

/** Границы полос по ершистости. Одна таблица на подписи и на раскладку: подпись,
    набранная отдельно от границы, расходится с ней молча. */
const CHOP_BANDS: ReadonlyArray<{ from: number; to: number | null }> = [
  { from: 0, to: 15 },
  { from: 15, to: 30 },
  { from: 30, to: 45 },
  { from: 45, to: null },
];

export interface ChopFilterBand {
  label: string;
  from: number;
  to: number | null;
  n: number;
  wins: number;
  winRate: number | null;
  ciLo: number | null;
  ciHi: number | null;
}

export interface ChopFilterReport {
  /** Пробои с записанной ершистостью И оценённым исходом — популяция отчёта */
  n: number;
  /** Пробои с исходом, но БЕЗ записанной ершистости: вне проверки, показываем явно */
  noScore: number;
  /** Общий win-rate пробоя на этой же популяции — с чем сравнивать полосы */
  overall: number | null;
  bands: ChopFilterBand[];
  claim: string;
}

export function chopFilterReport(): ChopFilterReport {
  const arr = loadSignals();
  const out = loadOutcomes();
  const bands = CHOP_BANDS.map((b) => ({
    label: b.to == null ? `${b.from}+` : `${b.from}–${b.to - 1}`,
    from: b.from,
    to: b.to,
    n: 0,
    wins: 0,
    winRate: null as number | null,
    ciLo: null as number | null,
    ciHi: null as number | null,
  }));
  let n = 0;
  let wins = 0;
  let noScore = 0;
  for (const sig of arr) {
    if (sig.pattern !== 'breakout') continue;
    const oc = out[sig.key];
    if (!oc || oc.win == null) continue; // истёкшие — отсутствие данных, а не промах
    if (sig.chopScore == null) {
      noScore++;
      continue;
    }
    const c = sig.chopScore;
    const band = bands.find((b) => c >= b.from && (b.to == null || c < b.to));
    if (!band) continue;
    band.n++;
    n++;
    if (oc.win) {
      band.wins++;
      wins++;
    }
  }
  for (const b of bands) {
    if (!b.n) continue;
    b.winRate = b.wins / b.n;
    const ci = wilsonInterval(b.wins, b.n);
    b.ciLo = ci ? ci.lo : null;
    b.ciHi = ci ? ci.hi : null;
  }
  return {
    n,
    noScore,
    overall: n ? wins / n : null,
    bands,
    claim:
      'Заявление ерша: чем выше ершистость на момент пробоя, тем чаще пробой ложный. ' +
      'Подтверждением считается win-rate верхних полос НИЖЕ нижней полосы, с неперекрывающимися интервалами. ' +
      'Пока интервалы перекрываются, эффекта не измерено — это не то же самое, что измеренное отсутствие эффекта.',
  };
}

export function patternStats(): { stats: PatternStat[]; anyWaiting: number } {
  const arr = loadSignals();
  const out = loadOutcomes();
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const edges = patternEdges();
  const stats: PatternStat[] = ALL_KINDS.map((k) => {
    const sigs = arr.filter((s) => s.pattern === k);
    const meta = PATTERN_META[k];
    let resolved = 0;
    let wins = 0;
    let losses = 0;
    let expired = 0;
    let waiting = 0;
    let mfeWinSum = 0;
    let mfeWinN = 0;
    let mfeLossSum = 0;
    let mfeLossN = 0;
    let pnlSum = 0;
    let pnlN = 0;
    let maeWinSum = 0;
    let maeWinN = 0;
    let grossSum = 0;
    let grossN = 0;
    let costSum = 0;
    let costN = 0;
    const byExit = { tp: 0, sl: 0, timeout: 0, converged: 0 };
    const bySrc = { series: 0, klines: 0, unknown: 0 };
    /* Win-rate, разбитый по затвору алерта. Фильтр, поставленный перед выдачей,
       делает опубликованную цифру описанием ДРУГОЙ популяции, чем та, на которой
       он выбран, — и проверить его больше нечем, если отфильтрованное перестать
       считать. Поэтому запись идёт по всем сигналам, а обе группы показываются
       рядом: контрольная группа и есть единственное доказательство, что затвор
       работает. */
    type GateAcc = { n: number; wins: number; pnl: number; pnlN: number };
    const mkAcc = (): GateAcc => ({ n: 0, wins: 0, pnl: 0, pnlN: 0 });
    const gate = { passed: mkAcc(), blockedZ: mkAcc(), blockedExec: mkAcc(), execUnknown: mkAcc() };
    for (const s of sigs) {
      const oc = out[s.key];
      if (!oc) {
        if (now - s.ts > HORIZON_MS) waiting++;
        continue;
      }
      if (oc.win == null) {
        expired++;
        continue;
      }
      resolved++;
      if (k === 'spread') {
        /* Затвор целиком: исполнимость по стакану И аномальность разрыва для самого
           символа. Каждая причина отсева — своя группа, иначе «прошедшие» смешивают
           отсеянное по одной причине с прошедшим по обеим. */
        const exec = execSpreadPct(s.netPct ?? null, s.slipRoundTripPct ?? null);
        const zOk = s.zScore != null && s.zScore >= SPREAD_ALERT_MIN_Z;
        const g = exec == null ? gate.execUnknown : exec <= 0 ? gate.blockedExec : zOk ? gate.passed : gate.blockedZ;
        g.n++;
        if (oc.win) g.wins++;
        if (oc.pnlPct != null) {
          g.pnl += oc.pnlPct;
          g.pnlN++;
        }
      }
      bySrc[oc.src ?? 'unknown']++;
      if (oc.exit) byExit[oc.exit]++;
      if (oc.pnlPct != null) {
        pnlSum += oc.pnlPct;
        pnlN++;
      }
      if (oc.pnlGrossPct != null) {
        grossSum += oc.pnlGrossPct;
        grossN++;
      }
      if (oc.costPct != null) {
        costSum += oc.costPct;
        costN++;
      }
      if (oc.win) {
        wins++;
        mfeWinSum += oc.mfePct ?? 0;
        mfeWinN++;
        if (oc.maePct != null) {
          maeWinSum += oc.maePct;
          maeWinN++;
        }
      } else {
        losses++;
        mfeLossSum += oc.mfePct ?? 0;
        mfeLossN++;
      }
    }
    return {
      pattern: k,
      icon: meta.icon,
      name: meta.name,
      hint: meta.hint,
      total: sigs.length,
      n24h: sigs.filter((s) => s.ts >= dayAgo).length,
      resolved,
      wins,
      losses,
      expired,
      waiting,
      winRate: wins + losses > 0 ? wins / (wins + losses) : null,
      avgMfeWin: mfeWinN ? Math.round((mfeWinSum / mfeWinN) * 100) / 100 : null,
      avgMfeLoss: mfeLossN ? Math.round((mfeLossSum / mfeLossN) * 100) / 100 : null,
      lastTs: sigs.length ? sigs[sigs.length - 1].ts : null,
      expectancyPct: pnlN ? Math.round((pnlSum / pnlN) * 1000) / 1000 : null,
      expectancyGrossPct: grossN ? Math.round((grossSum / grossN) * 1000) / 1000 : null,
      avgCostPct: costN ? Math.round((costSum / costN) * 1000) / 1000 : null,
      sumPnlPct: pnlN ? Math.round(pnlSum * 1000) / 1000 : null,
      byExit,
      bySrc,
      ...PATTERN_POPULATION[k],
      avgMaeWin: maeWinN ? Math.round((maeWinSum / maeWinN) * 100) / 100 : null,
      edge: edges[k],
      /* Затвор алерта против своей контрольной группы. Есть только у спреда —
         у остальных затвор совпадает с порогом записи, и делить нечего. */
      byAlertGate:
        k === 'spread'
          ? {
              minZ: SPREAD_ALERT_MIN_Z,
              gates: ['исполнимый спред > 0 (стакан известен)', `z >= ${SPREAD_ALERT_MIN_Z}`],
              passed: gateCell(gate.passed),
              blockedZ: gateCell(gate.blockedZ),
              blockedExec: gateCell(gate.blockedExec),
              execUnknown: gateCell(gate.execUnknown),
            }
          : null,
    };
  });
  return { stats, anyWaiting: stats.reduce((a, s) => a + s.waiting, 0) };
}

