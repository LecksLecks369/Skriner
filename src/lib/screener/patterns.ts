/* История паттернов: единый журнал сигналов всех типов + отложенная оценка исходов.

   Направленные паттерны (robot/sweep/whale/funding) оцениваются симуляцией выхода:
   сделка идёт по пути цены от входа, и фиксируется то, что случилось ПЕРВЫМ —
   тейк (+WIN_THR) или стоп (−STOP_THR); не задето ни то ни другое за 30 минут —
   выход по рынку на краю окна. Если в одной свече задеты обе границы, порядок внутри
   свечи неизвестен, поэтому засчитывается стоп (консервативно).

   Так делать обязательно: оценка «выиграл, если MFE дошёл до порога» считала выигрышем
   сделку, которая сначала сходила в минус на 4% и закрылась в убытке — просадка
   в метрику не входила вовсе, и win-rate завышался.

   spread (арбитраж) — исход не направленный: разрыв схлопнулся вдвое за 30 минут.

   Оценка исходов: сначала серии в памяти (до ~9ч), затем 1м-клайны биржи сигнала (до ~85м назад);
   если и там пусто — сигнал ждёт; старше 6 часов — помечается истёкшим (в win-rate не идёт). */

import fs from 'fs';
import path from 'path';
import type { Candle, ExchangeId } from './types';
import { fetchKlines } from './exchanges';
import { seriesStore } from './store';

export type PatternKind = 'spread' | 'robot' | 'sweep' | 'whale' | 'funding';

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
}

/** Версия методики оценки. Исходы, посчитанные старой методикой (MFE без учёта
    просадки), несравнимы с новыми — при загрузке они выбрасываются и пересчитываются. */
export const OUTCOME_VERSION = 2;

export type ExitReason = 'tp' | 'sl' | 'timeout';

export interface PatternOutcome {
  ts: number; // время оценки
  mfePct: number | null; // макс благоприятное движение % до выхода (в сторону dir)
  maePct: number | null; // макс неблагоприятное движение % до выхода
  movePct: number | null; // движение на краю 30-минутного окна (в сторону dir)
  win: boolean | null; // null = истёк без оценки
  expired?: boolean;
  /* поля симуляции выхода (только направленные паттерны, v2+) */
  v?: number; // версия методики
  exit?: ExitReason; // что сработало первым
  pnlPct?: number | null; // результат сделки по правилу выхода, % (тейк / −стоп / ход к краю окна)
}

/* ---------------- Хранилище ---------------- */

const DATA_DIR = path.join(process.cwd(), 'data');
const PATTERNS_FILE = path.join(DATA_DIR, 'pattern_history.jsonl');
const OUTCOMES_FILE = path.join(DATA_DIR, 'pattern_outcomes.json');
const MAX_SIGNALS = 3000;
const HORIZON_MS = 30 * 60 * 1000;
const EXPIRE_MS = 6 * 3600 * 1000;
const RESOLVE_BATCH = 10; // максимум дооценок за вызов (лимит API-нагрузки)

/** Тейк-профит: на сколько % в сторону сигнала сделка считается отработавшей */
export const WIN_THR: Record<PatternKind, number> = {
  spread: 0, // считается по схлопыванию, не по ходу цены
  robot: 0.5,
  sweep: 0.4,
  whale: 0.4,
  funding: 0.4,
};

/** Стоп-лосс: просадка, на которой сделка закрывается в минус. 1:1 к тейку —
    при таком R:R win-rate ниже ~50% означает, что паттерн не окупает даже комиссии. */
export const STOP_THR: Record<PatternKind, number> = {
  spread: 0, // не применяется
  robot: 0.5,
  sweep: 0.4,
  whale: 0.4,
  funding: 0.4,
};

const COOLDOWN_MS: Record<PatternKind, number> = {
  spread: 10 * 60_000,
  robot: 10 * 60_000,
  sweep: 30 * 60_000,
  whale: 60 * 60_000,
  funding: 60 * 60_000,
};

export const PATTERN_META: Record<PatternKind, { icon: string; name: string; hint: string }> = {
  spread: { icon: '🔀', name: 'Спред', hint: 'разрыв схлопнулся вдвое за 30 минут' },
  robot: { icon: '🤖', name: 'Робот вошёл', hint: 'тейк +0.5% раньше стопа −0.5% (30 минут)' },
  sweep: { icon: '🌊', name: 'Свип', hint: 'откат +0.4% раньше стопа −0.4% (30 минут)' },
  whale: { icon: '🐋', name: 'Киты', hint: 'ход по потоку +0.4% раньше стопа −0.4% (30 минут)' },
  funding: { icon: '💸', name: 'Фандинг', hint: 'ход против толпы +0.4% раньше стопа −0.4% (30 минут)' },
};

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
      /* Направленные исходы старой методики выбрасываем: там «победа» = MFE дошёл до
         порога, просадка не учитывалась, и такие win/loss нельзя складывать с новыми.
         Сигналы, по которым ещё есть данные, дооценятся заново; остальные истекут. */
      let dropped = 0;
      for (const [key, oc] of Object.entries(raw)) {
        const isSpread = key.startsWith('spread:');
        const stale = !isSpread && oc.win != null && (oc.v ?? 1) < OUTCOME_VERSION;
        if (stale) {
          dropped++;
          continue;
        }
        pst.outcomes[key] = oc;
      }
      if (dropped) {
        console.warn(`[patterns] исходов старой методики отброшено: ${dropped} (будут пересчитаны по правилу выхода)`);
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
    к результату отношения не имеет. */
function evalDirectional(
  path: PathPt[],
  entry: number,
  dir: 'long' | 'short',
  ts0: number,
  tpPct: number,
  slPct: number
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
  const pnl = exit === 'tp' ? tpPct : exit === 'sl' ? -slPct : move;
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
  };
}

/** Схлопывание спреда: min(spread в окне [ts+5м, ts+30м]) <= 0.5 * spread0 */
function evalSpreadSeries(symbol: string, ts0: number, spread0: number): PatternOutcome | null {
  const hist = seriesStore.getSpreadHistory(symbol);
  const from = ts0 + 5 * 60_000;
  const to = ts0 + HORIZON_MS;
  const after = hist.filter((p) => p.ts >= from && p.ts <= to);
  if (after.length < 8) return null;
  const minAfter = Math.min(...after.map((p) => p.v));
  return {
    ts: Date.now(),
    mfePct: Math.round(((spread0 - minAfter) / Math.max(spread0, 1e-9)) * 1000) / 1000, // % схлопывания
    maePct: null,
    movePct: Math.round((minAfter - spread0) * 1000) / 1000, // до какого уровня дошёл, п.п.
    win: minAfter <= spread0 * 0.5,
    v: OUTCOME_VERSION,
  };
}

async function evalSpreadKlines(sig: PatternSignal): Promise<PatternOutcome | null> {
  if (!sig.hiEx || !sig.loEx || !sig.hiNative || !sig.loNative || !sig.hiPrice || !sig.loPrice || !sig.spreadPct) return null;
  const [hi, lo] = await Promise.all([klinesPath(sig.hiEx, sig.hiNative), klinesPath(sig.loEx, sig.loNative)]);
  if (!hi || !lo) return null;
  const loMap = new Map(lo.map((p) => [Math.round(p.ts / 60_000), p.c]));
  const from = sig.ts + 5 * 60_000;
  const to = sig.ts + HORIZON_MS;
  const spreads: number[] = [];
  for (const p of hi) {
    if (p.ts < from || p.ts > to) continue;
    const lc = loMap.get(Math.round(p.ts / 60_000));
    if (!lc) continue;
    const hiC = p.c;
    const mid = (hiC + lc) / 2;
    if (mid <= 0) continue;
    spreads.push(((Math.max(hiC, lc) - Math.min(hiC, lc)) / mid) * 100);
  }
  if (spreads.length < 8) return null;
  const minAfter = Math.min(...spreads);
  return {
    ts: Date.now(),
    mfePct: Math.round(((sig.spreadPct - minAfter) / Math.max(sig.spreadPct, 1e-9)) * 1000) / 1000,
    maePct: null,
    movePct: Math.round((minAfter - sig.spreadPct) * 1000) / 1000,
    win: minAfter <= sig.spreadPct * 0.5,
    v: OUTCOME_VERSION,
  };
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
        if (sig.pattern === 'spread' && sig.spreadPct != null) {
          oc = evalSpreadSeries(sig.symbol, sig.ts, sig.spreadPct);
          if (!oc) oc = await evalSpreadKlines(sig);
        } else if (sig.dir !== 'arb') {
          const tp = WIN_THR[sig.pattern] ?? 0.4;
          const sl = STOP_THR[sig.pattern] ?? tp;
          // 1) серии в памяти (покрывают до ~9ч при живом сервере)
          oc = evalDirectional(seriesPath(sig.symbol, sig.ex), sig.price, sig.dir, sig.ts, tp, sl);
          // 2) клайны биржи сигнала (покрывают ~85 минут назад)
          if (!oc && sig.ex && sig.native) {
            const path = await klinesPath(sig.ex, sig.native);
            if (path) oc = evalDirectional(path, sig.price, sig.dir, sig.ts, tp, sl);
          }
        }
        if (!oc) {
          if (now - sig.ts > EXPIRE_MS) {
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
  expectancyPct: number | null; // среднее pnl на сделку, %; отрицательное = паттерн не окупается
  sumPnlPct: number | null; // суммарный pnl по разрешённым сделкам, %
  byExit: { tp: number; sl: number; timeout: number }; // чем закрывались сделки
  avgMaeWin: number | null; // средняя просадка у выигравших, % — цена, которую пришлось пересидеть
}

export function patternStats(): { stats: PatternStat[]; anyWaiting: number } {
  const arr = loadSignals();
  const out = loadOutcomes();
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const kinds: PatternKind[] = ['spread', 'robot', 'sweep', 'whale', 'funding'];
  const stats: PatternStat[] = kinds.map((k) => {
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
    const byExit = { tp: 0, sl: 0, timeout: 0 };
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
      if (oc.exit) byExit[oc.exit]++;
      if (oc.pnlPct != null) {
        pnlSum += oc.pnlPct;
        pnlN++;
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
      sumPnlPct: pnlN ? Math.round(pnlSum * 1000) / 1000 : null,
      byExit,
      avgMaeWin: maeWinN ? Math.round((maeWinSum / maeWinN) * 100) / 100 : null,
    };
  });
  return { stats, anyWaiting: stats.reduce((a, s) => a + s.waiting, 0) };
}

