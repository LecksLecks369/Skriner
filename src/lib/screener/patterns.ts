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

   Оценка исходов: сначала серии в памяти (до ~9ч), затем 1м-клайны биржи сигнала (до ~85м назад);
   если и там пусто — сигнал ждёт; старше 6 часов — помечается истёкшим (в win-rate не идёт). */

import fs from 'fs';
import path from 'path';
import type { Candle, ExchangeId } from './types';
import { fetchKlines } from './exchanges';
import { seriesStore } from './store';
import { BREAKOUT_ALERT, CHOP_BASE_RATE, CHOP_ER_MAX, CHOP_SCORE_MIN } from './setups';
import {
  arbConvergeLevelPct,
  arbFeesPct,
  arbSlLevelPct,
  arbTpTargetPct,
  directionalCostPct,
  feePairPct,
} from './costs';
import { computeEdge, computeRateEdge, type EdgeReport } from './edge';

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
export const OUTCOME_VERSION = 3;

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
const HORIZON_MS = 30 * 60 * 1000;
const EXPIRE_MS = 6 * 3600 * 1000;
const RESOLVE_BATCH = 10; // максимум дооценок за вызов (лимит API-нагрузки)

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
    population: `нетто-спред ≥ ${RECORD_THR.spreadNetPct}% · не чаще раза в 10 мин на символ`,
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
    population: `скор ершистости ≥ ${CHOP_SCORE_MIN} и ER ≤ ${CHOP_ER_MAX} (p10 популяции) · базовая частота исхода ${Math.round(CHOP_BASE_RATE * 100)}%`,
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

const COOLDOWN_MS: Record<PatternKind, number> = {
  spread: 10 * 60_000,
  robot: 10 * 60_000,
  sweep: 30 * 60_000,
  whale: 60 * 60_000,
  funding: 60 * 60_000,
  breakout: 20 * 60_000,
  distribution: 30 * 60_000,
  chop: 30 * 60_000,
};

export const PATTERN_META: Record<PatternKind, { icon: string; name: string; hint: string }> = {
  spread: { icon: '🔀', name: 'Спред', hint: 'сделка на разрыве: прибыль после комиссий круга (30 минут)' },
  robot: { icon: '🤖', name: 'Робот вошёл', hint: 'тейк +0.5% раньше стопа −0.5%, минус круг тейкером (30 минут)' },
  sweep: { icon: '🌊', name: 'Свип', hint: 'откат +0.4% раньше стопа −0.4%, минус круг тейкером (30 минут)' },
  whale: { icon: '🐋', name: 'Киты', hint: 'ход по потоку +0.4% раньше стопа −0.4%, минус круг тейкером (30 минут)' },
  funding: { icon: '💸', name: 'Фандинг', hint: 'ход против толпы +0.4% раньше стопа −0.4%, минус круг тейкером (30 минут)' },
  breakout: { icon: '⚡', name: 'Пробой', hint: 'ход в сторону уровня +0.5% раньше стопа −0.5% (30 минут)' },
  distribution: { icon: '📦', name: 'Раздача', hint: 'разворот против пампа/дампа +0.5% раньше стопа −0.5% (30 минут)' },
  chop: { icon: '〰', name: 'Ёрш', hint: 'пила сохранилась: эффективность хода за следующие 30 минут ≤ 0.025 (p10 популяции) — базовая частота такого исхода 10%' },
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
        const stale = legacyChop || (oc.win != null && (oc.v ?? 1) < OUTCOME_VERSION);
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

interface PathPt {
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
  const pnl = gross - costPct;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    ts: Date.now(),
    mfePct: r3(mfe),
    maePct: r3(mae),
    movePct: r3(move),
    win: pnl > 0,
    v: OUTCOME_VERSION,
    exit,
    pnlPct: r3(pnl),
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

function evalChopPersist(path: PathPt[], entry: number, ts0: number, erMax: number): PatternOutcome | null {
  const closes = minuteCloses(path, ts0);
  if (closes.length < 12) return null; // на десятке точек эффективность — шум
  let travelled = 0;
  for (let i = 1; i < closes.length; i++) travelled += Math.abs(closes[i] - closes[i - 1]);
  if (travelled <= 0) return null;
  const net = closes[closes.length - 1] - closes[0];
  const er = Math.abs(net) / travelled;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    ts: Date.now(),
    mfePct: null,
    maePct: entry > 0 ? r3((Math.max(...closes.map((c) => Math.abs(c - entry))) / entry) * 100) : null,
    movePct: entry > 0 ? r3((net / entry) * 100) : null,
    win: er <= erMax,
    v: OUTCOME_VERSION,
    pnlPct: null,
    erAfter: r3(er),
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
  const cost = arbFeesPct(loEx, hiEx);
  const from = sig.ts + 5 * 60_000;
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
  return {
    ts: Date.now(),
    mfePct: r3(mfe), // лучший P&L за окно, п.п. (не % схлопывания, как было до v3)
    maePct: r3(mae),
    movePct: r3(netNow - netEntry), // насколько сдвинулся нетто-спред, п.п. (минус = сошёлся)
    win: pnl > 0,
    v: OUTCOME_VERSION,
    exit,
    pnlPct: r3(pnl),
    pnlGrossPct: r3(pnl + cost),
    costPct: r3(cost),
    costSlipModeled: false,
  };
}

/** Путь спреда из серий в памяти: кросс-спред монеты (валовый, до комиссий) */
function spreadPathFromSeries(symbol: string): SpreadPt[] {
  return seriesStore.getSpreadHistory(symbol).map((p) => ({ ts: p.ts, gross: p.v }));
}

/** Путь спреда из 1м-клайнов обеих бирж: разрыв закрытий как прокси разрыва котировок */
async function spreadPathFromKlines(sig: PatternSignal): Promise<SpreadPt[] | null> {
  if (!sig.hiEx || !sig.loEx || !sig.hiNative || !sig.loNative) return null;
  const [hi, lo] = await Promise.all([klinesPath(sig.hiEx, sig.hiNative), klinesPath(sig.loEx, sig.loNative)]);
  if (!hi || !lo) return null;
  const loMap = new Map(lo.map((p) => [Math.round(p.ts / 60_000), p.c]));
  const out: SpreadPt[] = [];
  for (const p of hi) {
    const lc = loMap.get(Math.round(p.ts / 60_000));
    if (!lc) continue;
    const mid = (p.c + lc) / 2;
    if (mid <= 0) continue;
    out.push({ ts: p.ts, gross: ((Math.max(p.c, lc) - Math.min(p.c, lc)) / mid) * 100 });
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
    const pending = arr
      .filter((s) => !out[s.key] && now - s.ts > HORIZON_MS + 2 * 60_000)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, RESOLVE_BATCH);
    let resolved = 0;
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
          oc = from(simulateSpreadTrade(sig, spreadPathFromSeries(sig.symbol)), 'series');
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
            oc = from(evalChopPersist(seriesPath(sig.symbol, sig.ex), sig.price, sig.ts, erMax), 'series');
            if (!oc && sig.ex && sig.native) {
              const path = await klinesPath(sig.ex, sig.native);
              if (path) oc = from(evalChopPersist(path, sig.price, sig.ts, erMax), 'klines');
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
}

/* ---------------- Эдж и авто-отключение ---------------- */

/**
 * Чистые результаты сделок по каждому типу, в хронологическом порядке.
 * Только разрешённые исходы: истёкшие (win == null) — это отсутствие данных, а не ноль,
 * и включать их в матожидание нельзя ни как ноль, ни как убыток.
 */
function pnlSequences(): Record<PatternKind, number[]> {
  const arr = loadSignals();
  const out = loadOutcomes();
  const seq = Object.fromEntries(ALL_KINDS.map((k) => [k, [] as number[]])) as Record<PatternKind, number[]>;
  for (const s of arr) {
    const oc = out[s.key];
    if (!oc || oc.win == null || oc.pnlPct == null) continue;
    seq[s.pattern]?.push(oc.pnlPct);
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
  chop: CHOP_BASE_RATE,
};

/**
 * Попадания по каждому типу из RATE_BASELINE, в хронологическом порядке.
 * Фильтр тот же, что у pnlSequences: истёкшие (win == null) — отсутствие данных, а не промах.
 */
function hitSequences(): Record<PatternKind, boolean[]> {
  const arr = loadSignals();
  const out = loadOutcomes();
  const seq = Object.fromEntries(ALL_KINDS.map((k) => [k, [] as boolean[]])) as Record<PatternKind, boolean[]>;
  for (const s of arr) {
    const oc = out[s.key];
    if (!oc || oc.win == null) continue;
    seq[s.pattern]?.push(oc.win);
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
      return [k, base != null ? computeRateEdge(hits[k], base) : computeEdge(seq[k])];
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
    };
  });
  return { stats, anyWaiting: stats.reduce((a, s) => a + s.waiting, 0) };
}

