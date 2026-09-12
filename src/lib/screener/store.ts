import fs from 'fs';
import path from 'path';
import type { ExchangeId } from './types';

/* Персистентный стор: переживает HMR и горячие перезапуски dev-сервера.
   Серии хранятся в памяти, журнал сигналов — на диске (JSONL). */

interface Pt {
  ts: number;
  v: number;
}

/** Котировка одной биржи в момент ts: лучший бид и лучший аск */
export interface QPt {
  ts: number;
  b: number;
  a: number;
}

export interface Series {
  prices: Record<string, Record<string, Pt[]>>; // symbol -> exchange -> [ts, price]
  /* Котировки ПО БИРЖАМ — чтобы путь разрыва считался по той же паре и тем же
     выражением, что и вход. crossSpread ниже хранит разрыв ЛУЧШЕЙ пары на каждом
     тике, а лучшая пара меняется: на LSKUSDT за 38 минут контрагентом побывали
     четыре биржи подряд. Путь по такой серии сравнивает вход по одной паре с
     выходом по другой, и результат описывает перестановку пар, а не сделку. */
  quotes: Record<string, Record<string, QPt[]>>; // symbol -> exchange -> [ts, bid, ask]
  crossSpread: Record<string, Pt[]>; // symbol -> [ts, pct] — ЛУЧШАЯ пара, для z-score и графика
  oi: Record<string, Record<string, Pt[]>>; // symbol -> exchange -> [ts, oi]
  funding: Record<string, Record<string, Pt[]>>; // symbol -> exchange -> [ts, rate]
  firstSignal: Record<string, number>; // symbol -> ts первого сигнала (спред >= порога)
  lastSignalTs: Record<string, number>;
}

export interface JournalEntry {
  ts: number;
  symbol: string;
  /* Разрыв котировок ДО вычета комиссий, % — та же величина, что пишется в серию
     crossSpread, поэтому путь разрыва и вход сравнимы между собой. Раньше сюда
     писался НЕТТО-спред: поле называлось spreadPct, содержало нетто, было побайтово
     равно netPct на всех строках, и при этом сравнивалось с путём ГРОСС-разрыва в
     тесте на схлопывание — два разных выражения под одним именем. Строки, у которых
     spreadPct === netPct, записаны по старому правилу: гросс в них не восстановить
     (комиссии пары не сохранены), и тест на схлопывание для них не проводится. */
  spreadPct: number;
  /** Разрыв за вычетом комиссий ОДНОГО пересечения пары книг, % */
  netPct: number | null;
  zScore: number | null;
  score: number;
  refExchange: ExchangeId;
  hiExchange: ExchangeId;
  loExchange: ExchangeId;
  outcomeTs?: number;
  /* Гросс-разрыв сжался вдвое ВНУТРИ горизонта. Это факт о рынке, а не результат
     сделки: круг регулярно стоит дороже разрыва, поэтому схлопывание ничего не
     говорит о прибыли. Прибыль живёт в истории паттернов (pnlPct со слипейджем). */
  outcomeConv?: boolean;
}

const MAX_PTS = 720; // 720 * 45с ≈ 9 часов истории
const DATA_DIR = path.join(process.cwd(), 'data');
const JOURNAL_FILE = path.join(DATA_DIR, 'signal_journal.jsonl');

function newSeries(): Series {
  return { prices: {}, quotes: {}, crossSpread: {}, oi: {}, funding: {}, firstSignal: {}, lastSignalTs: {} };
}

interface StoreGlobal {
  __screenerStore: { series: Series; journal: JournalEntry[]; journalLoaded: boolean };
}
const g = globalThis as unknown as StoreGlobal;
if (!g.__screenerStore) {
  g.__screenerStore = { series: newSeries(), journal: [], journalLoaded: false };
}
const store = g.__screenerStore;

/**
 * Достроить недостающие разделы Series на живом объекте.
 *
 * `store.series` живёт в globalThis и переживает hot-reload: объект создаётся
 * ОДИН раз, той версией `newSeries()`, что была в процессе на момент старта.
 * Добавление нового раздела правит только конструктор — у уже живущего объекта
 * поля по-прежнему нет, и первое же обращение падает на `undefined`. Ровно это и
 * случилось при добавлении `quotes`: `[scan] failed: Cannot read properties of
 * undefined (reading 'ETHUSDT')` на каждом скане, при том что типы сходились, а
 * линтер молчал — оба видят конструктор, а не объект в памяти.
 *
 * Тот же случай — series.json, записанный прошлой версией: в нём раздела тоже нет.
 */
function ensureQuotes(): Record<string, Record<string, QPt[]>> {
  return (store.series.quotes ||= {});
}

function pushPt(arr: Pt[] | undefined, ts: number, v: number): Pt[] {
  const a = arr || [];
  if (a.length && ts - a[a.length - 1].ts < 30_000 && Math.abs(a[a.length - 1].v - v) < 1e-12) return a;
  a.push({ ts, v });
  if (a.length > MAX_PTS) a.splice(0, a.length - MAX_PTS);
  return a;
}

export const seriesStore = {
  addPrice(symbol: string, ex: ExchangeId, ts: number, price: number) {
    const s = (store.series.prices[symbol] ||= {});
    s[ex] = pushPt(s[ex], ts, price);
  },
  addCrossSpread(symbol: string, ts: number, pct: number) {
    store.series.crossSpread[symbol] = pushPt(store.series.crossSpread[symbol], ts, pct);
  },
  addOi(symbol: string, ex: ExchangeId, ts: number, oi: number) {
    const s = (store.series.oi[symbol] ||= {});
    s[ex] = pushPt(s[ex], ts, oi);
  },
  addFunding(symbol: string, ex: ExchangeId, ts: number, rate: number) {
    const s = (store.series.funding[symbol] ||= {});
    s[ex] = pushPt(s[ex], ts, rate);
  },
  addQuote(symbol: string, ex: ExchangeId, ts: number, bid: number, ask: number) {
    const s = (ensureQuotes()[symbol] ||= {});
    const arr = (s[ex] ||= []);
    const last = arr[arr.length - 1];
    if (last && ts - last.ts < 30_000 && last.b === bid && last.a === ask) return;
    arr.push({ ts, b: bid, a: ask });
    if (arr.length > MAX_PTS) arr.splice(0, arr.length - MAX_PTS);
  },
  getSpreadHistory(symbol: string): Pt[] {
    return store.series.crossSpread[symbol] || [];
  },
  /**
   * Путь ВАЛОВОГО разрыва конкретной пары бирж: продаём в бид на hiEx, покупаем
   * в аск на loEx — ровно то выражение, по которому считался вход.
   *
   * Знак сохраняется: отрицательное значение означает, что книги разошлись в
   * обратную сторону, и это не то же самое, что схлопывание. Модуль разности,
   * который стоял в ветке свечей, делает эти два состояния неразличимыми и
   * показывает разошедшийся разрыв как несошедшийся.
   *
   * Тики обеих бирж пишутся одним и тем же `now` внутри одного скана, поэтому
   * соединение идёт по точному ts — никакого сглаживания и никакой интерполяции.
   */
  getPairSpreadPath(symbol: string, hiEx: ExchangeId, loEx: ExchangeId): Array<{ ts: number; gross: number }> {
    const per = ensureQuotes()[symbol];
    if (!per) return [];
    const hi = per[hiEx];
    const lo = per[loEx];
    if (!hi?.length || !lo?.length) return [];
    const loBy = new Map(lo.map((p) => [p.ts, p]));
    const out: Array<{ ts: number; gross: number }> = [];
    for (const h of hi) {
      const l = loBy.get(h.ts);
      if (!l || !(l.a > 0)) continue;
      out.push({ ts: h.ts, gross: ((h.b - l.a) / l.a) * 100 });
    }
    return out;
  },
  /** Все серии цен монеты по биржам (для оценки исходов паттернов) */
  getPricePoints(symbol: string): Record<string, Pt[]> {
    return store.series.prices[symbol] || {};
  },
  getPriceSeries(symbol: string, ex: ExchangeId): Pt[] {
    return store.series.prices[symbol]?.[ex] || [];
  },
  /** ΔOI % за окно по объединению бирж (среднее по тем, у кого есть история) */
  dOiPct(symbol: string, windowMs: number): number | null {
    const per = store.series.oi[symbol];
    if (!per) return null;
    const now = Date.now();
    const vals: number[] = [];
    for (const ex of Object.keys(per)) {
      const arr = per[ex];
      if (!arr || arr.length < 2) continue;
      const cur = arr[arr.length - 1];
      // ищем точку ближе к окну
      let base: Pt | null = null;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (now - arr[i].ts >= windowMs) {
          base = arr[i];
          break;
        }
      }
      if (!base || base.v <= 0) continue;
      vals.push(((cur.v - base.v) / base.v) * 100);
    }
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  },
  /** z-score текущего спреда против своей истории (последние 2-4 часа) */
  spreadZScore(symbol: string, cur: number): number | null {
    const arr = store.series.crossSpread[symbol];
    if (!arr || arr.length < 15) return null;
    const hist = arr.slice(-240).map((p) => p.v);
    const n = hist.length;
    const mean = hist.reduce((a, b) => a + b, 0) / n;
    const varr = hist.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    const std = Math.sqrt(varr);
    /* Нулевая дисперсия — это «разброс не измерен», а не «отклонение огромно».
       Здесь стояло `return 3.5`: выдуманное значение, которое проходит любой
       порог. А ряд из одинаковых значений — типовой признак замороженного
       фида, то есть ровно того случая, по которому алертить нельзя. Из двух
       ошибок обратима только одна: пропущенный скачок на стабильном спреде
       виден и дождётся следующих тиков, когда дисперсия появится, а сделка по
       залипшей котировке не видна никак. */
    if (std < 1e-6) return null;
    return Math.max(-5, Math.min(8, (cur - mean) / std));
  },
  /** Возраст сигнала: ставим метку, пока спред выше порога, и снимаем, когда он опустился ниже.
      Вызывать на каждом скане для каждой монеты, иначе метка никогда не сбрасывается. */
  trackSignalAge(symbol: string, ts: number, thresholdPct: number, spreadPct: number | null) {
    if (spreadPct != null && spreadPct >= thresholdPct) {
      if (!store.series.firstSignal[symbol]) store.series.firstSignal[symbol] = ts;
    } else {
      delete store.series.firstSignal[symbol];
    }
  },
  /** Отметка о записи в журнал — только для cooldown, не для возраста сигнала */
  markJournaled(symbol: string, ts: number) {
    store.series.lastSignalTs[symbol] = ts;
  },
  /** Снять метки возраста у монет, которых нет в текущем скане: их спред мы больше не наблюдаем,
      иначе метка висит до перезапуска и при возврате монеты в топ покажет фиктивный возраст */
  dropSignalAgesExcept(symbols: Set<string>) {
    for (const sym of Object.keys(store.series.firstSignal)) {
      if (!symbols.has(sym)) delete store.series.firstSignal[sym];
    }
  },
  getLastSignalTs(symbol: string): number {
    return store.series.lastSignalTs[symbol] || 0;
  },
  signalAge(symbol: string, now: number): number | null {
    const t0 = store.series.firstSignal[symbol];
    return t0 ? (now - t0) / 60000 : null;
  },
};

/* --------- Журнал сигналов (персистентный) --------- */
export function appendJournal(entry: JournalEntry) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(entry) + '\n');
    store.journal.push(entry);
    if (store.journal.length > 5000) store.journal.splice(0, store.journal.length - 5000);
  } catch {
    /* диск недоступен — журнал в памяти */
  }
}

function loadJournal(): JournalEntry[] {
  if (store.journalLoaded) return store.journal;
  store.journalLoaded = true;
  try {
    if (fs.existsSync(JOURNAL_FILE)) {
      const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').trim().split('\n').filter(Boolean);
      store.journal = lines.slice(-5000).map((l) => JSON.parse(l) as JournalEntry);
    }
  } catch {
    store.journal = [];
  }
  return store.journal;
}

/**
 * Сводка журнала + доращивание исходов «гросс-разрыв сжался вдвое внутри горизонта».
 *
 * horizonMs передаётся вызывающим, а не объявляется здесь: это ТОТ ЖЕ horizon, по
 * которому оценивается история паттернов (HORIZON_MS в patterns.ts). Вторая копия
 * константы рядом с подписью «за 30 минут» рассинхронизировалась бы при первом же
 * изменении горизонта, и подпись осталась бы правдоподобной.
 *
 * Три исправленных дефекта, все — расхождение подписи и выражения:
 *
 * 1. Окно было НЕ ОГРАНИЧЕНО сверху: `after` брал все точки позже ts+25м, и минимум
 *    считался по всей оставшейся истории. «Сошёлся за 30 минут» означало «когда-нибудь
 *    после 25-й минуты», а у шумного ряда минимум почти всегда рано или поздно
 *    проваливается ниже половины — отсюда 82% схлопывания против 65% выигрышных
 *    сделок на том же детекторе. Теперь окно закрыто горизонтом.
 * 2. Сравнивались разные величины: путь брался из crossSpread (ГРОСС), а порог — из
 *    e.spreadPct, куда писался НЕТТО. Теперь обе стороны гросс.
 * 3. Старые строки (spreadPct === netPct, то есть нетто в поле гросса) не
 *    оцениваются вовсе, а не оцениваются по подставленному значению: подстановка
 *    производит запись, которую тест всё равно не описывает. Их число возвращается
 *    отдельно — «сколько строк вопрос не охватывает» и «сколько ещё ждут» это
 *    противоположные состояния, и только одно из них разрешается временем.
 */
export function journalSummary(horizonMs: number): {
  signals24h: number;
  conv30m: number | null;
  convN: number;
  pending: number;
  legacy: number;
  total: number;
} {
  const all = loadJournal();
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  let withOutcome = 0;
  let conv = 0;
  let pending = 0;
  let legacy = 0;
  for (const e of all) {
    if (e.outcomeConv !== undefined) {
      withOutcome++;
      if (e.outcomeConv) conv++;
      continue;
    }
    /* Гросс строго больше нетто на комиссии пары; равенство — признак строки,
       записанной до разделения полей. Гросс в ней не восстановить. */
    if (e.netPct != null && e.spreadPct === e.netPct) {
      legacy++;
      continue;
    }
    if (now - e.ts < horizonMs) {
      pending++;
      continue;
    }
    const hist = store.series.crossSpread[e.symbol];
    if (!hist) {
      pending++;
      continue;
    }
    /* Окно закрыто с ДВУХ сторон: [ts + 25м; ts + horizon]. Верхняя граница и есть
       та «30 минута», которая стоит в подписи. */
    const from = e.ts + 25 * 60 * 1000;
    const to = e.ts + horizonMs;
    const win = hist.filter((p) => p.ts > from && p.ts <= to);
    if (!win.length) {
      pending++;
      continue;
    }
    const minAfter = Math.min(...win.map((p) => p.v));
    e.outcomeTs = win[0].ts;
    e.outcomeConv = minAfter <= e.spreadPct * 0.5;
    withOutcome++;
    if (e.outcomeConv) conv++;
  }
  const recent = all.filter((e) => e.ts >= dayAgo);
  return {
    signals24h: recent.length,
    conv30m: withOutcome > 0 ? conv / withOutcome : null,
    convN: withOutcome,
    pending,
    legacy,
    total: all.length,
  };
}

export function recentSignals(limit = 60): JournalEntry[] {
  const all = loadJournal();
  return all.slice(-limit).reverse();
}

/* --------- Репутация монет: как часто её сигналы были верными --------- */
export interface SymbolRep {
  n: number;
  winRate: number | null;
}

export function symbolReputation(): Record<string, SymbolRep> {
  const all = loadJournal();
  const acc: Record<string, { n: number; win: number; decided: number }> = {};
  for (const e of all) {
    const a = (acc[e.symbol] ||= { n: 0, win: 0, decided: 0 });
    a.n++;
    if (e.outcomeConv !== undefined) {
      a.decided++;
      if (e.outcomeConv) a.win++;
    }
  }
  const out: Record<string, SymbolRep> = {};
  for (const [sym, a] of Object.entries(acc)) {
    out[sym] = {
      n: a.n,
      winRate: a.decided > 0 ? a.win / a.decided : null,
    };
  }
  return out;
}

/* --------- Снапшоты для бэктеста фильтров --------- */
/* Каждый свежий скан пишет одну строку: { ts, pts: [{s, net, hi, lo, pBuy, pSell, sc}] }.
   Файл data/snapshots.jsonl — кольцевой (~36 часов), бэктест проигрывает фильтры по нему. */

const SNAP_FILE = path.join(DATA_DIR, 'snapshots.jsonl');
const SNAP_KEEP_MS = 36 * 3600 * 1000;
const SNAP_MAX_LINES = 4000;

export interface SnapPt {
  s: string; // symbol
  net: number; // нетто-спред %
  hi: ExchangeId;
  lo: ExchangeId;
  pBuy: number;
  pSell: number;
  sc: number; // скор
  /* Слипейдж ОДНОГО пересечения обеих книг на момент снимка, % (deep-блок).
     Пишется, чтобы бэктест и оптимизатор могли посчитать издержки круга той же
     моделью, что и симулятор: без него они считали P&L как netEntry − netExit,
     где комиссии сокращаются, а слипейджа нет вовсе, — то есть круг выходил
     бесплатным, и сетка порогов всегда выбирала самый мягкий порог.
     Отсутствует у строк без стакана и у всех снимков до появления поля. */
  slip?: number;
  /* Версия шкалы скора, которой посчитан sc. Скор стал долей ДОСТУПНОГО веса
     вместо суммы слагаемых, то есть числа до и после несравнимы. Порог по скору,
     приложенный к точкам двух шкал сразу, даёт тихо неверную выборку, поэтому
     версия едет в самой точке. Отсутствует = старая шкала (сумма). */
  sv?: number;
}

export interface SnapLine {
  ts: number;
  pts: SnapPt[];
}

interface SnapGlobal {
  __screenerSnaps: { lines: SnapLine[]; loaded: boolean; writes: number };
}
const sg = globalThis as unknown as SnapGlobal;
if (!sg.__screenerSnaps) sg.__screenerSnaps = { lines: [], loaded: false, writes: 0 };
const snapStore = sg.__screenerSnaps;

function loadSnaps(): SnapLine[] {
  if (snapStore.loaded) return snapStore.lines;
  snapStore.loaded = true;
  try {
    if (fs.existsSync(SNAP_FILE)) {
      const lines = fs.readFileSync(SNAP_FILE, 'utf8').trim().split('\n').filter(Boolean);
      snapStore.lines = lines.slice(-SNAP_MAX_LINES).map((l) => JSON.parse(l) as SnapLine);
    }
  } catch {
    snapStore.lines = [];
  }
  return snapStore.lines;
}

export function appendSnapshot(pts: SnapPt[]) {
  const line: SnapLine = { ts: Date.now(), pts };
  const arr = loadSnaps();
  arr.push(line);
  if (arr.length > SNAP_MAX_LINES) arr.splice(0, arr.length - SNAP_MAX_LINES);
  snapStore.writes++;
  // периодическая обрезка файла по времени
  if (snapStore.writes % 100 === 0) {
    const cutoff = Date.now() - SNAP_KEEP_MS;
    while (arr.length && arr[0].ts < cutoff) arr.shift();
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SNAP_FILE, arr.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return;
    } catch {
      /* диск недоступен — держим в памяти */
    }
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(SNAP_FILE, JSON.stringify(line) + '\n');
  } catch {
    /* диск недоступен */
  }
}

export function loadSnapshotLines(hours: number): SnapLine[] {
  const cutoff = Date.now() - Math.min(hours, 48) * 3600 * 1000;
  return loadSnaps().filter((l) => l.ts >= cutoff);
}

/* --------- Прогрев: сериализация серий на диск ---------
   После рестарта сервера серии в памяти пусты и z-score/ΔOI/возраст набираются ~час.
   Периодически пишем весь Series в data/series.json, при старте — восстанавливаем.
   Потеря при жёстком убийстве процесса ≤ ~2 минут истории. */

const SERIES_FILE = path.join(DATA_DIR, 'series.json');
const SERIES_KEEP_MS = 10 * 3600 * 1000; // старше 10ч — чистим при записи
const PERSIST_DELAY_MS = 90_000;

interface WarmGlobal {
  __screenerSeriesWarm: { loaded: boolean; timer: ReturnType<typeof setTimeout> | null; writing: boolean };
}
const wg = globalThis as unknown as WarmGlobal;
if (!wg.__screenerSeriesWarm) wg.__screenerSeriesWarm = { loaded: false, timer: null, writing: false };
const warm = wg.__screenerSeriesWarm;

function prunePts(arr: Pt[] | undefined, cutoff: number): Pt[] {
  if (!arr) return [];
  return arr.filter((p) => p.ts >= cutoff).slice(-MAX_PTS);
}

/** Восстановить серии с диска (один раз за процесс, до первой записи). */
export function warmupSeries() {
  if (warm.loaded) return;
  warm.loaded = true;
  // серии уже живут (HMR того же процесса) — грузить нечем
  if (Object.keys(store.series.prices).length > 0) return;
  try {
    if (!fs.existsSync(SERIES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SERIES_FILE, 'utf8')) as Series;
    const cutoff = Date.now() - SERIES_KEEP_MS;
    const next = newSeries();
    for (const [sym, per] of Object.entries(raw.prices || {})) {
      const np: Record<string, Pt[]> = {};
      for (const [ex, arr] of Object.entries(per)) {
        const pr = prunePts(arr, cutoff);
        if (pr.length) np[ex] = pr;
      }
      if (Object.keys(np).length) next.prices[sym] = np;
    }
    for (const [sym, per] of Object.entries(raw.quotes || {})) {
      const np: Record<string, QPt[]> = {};
      for (const [ex, arr] of Object.entries(per)) {
        const pr = (arr || []).filter((p) => p.ts >= cutoff).slice(-MAX_PTS);
        if (pr.length) np[ex] = pr;
      }
      if (Object.keys(np).length) next.quotes[sym] = np;
    }
    for (const [sym, arr] of Object.entries(raw.crossSpread || {})) {
      const pr = prunePts(arr, cutoff);
      if (pr.length) next.crossSpread[sym] = pr;
    }
    for (const [sym, per] of Object.entries(raw.oi || {})) {
      const np: Record<string, Pt[]> = {};
      for (const [ex, arr] of Object.entries(per)) {
        const pr = prunePts(arr, cutoff);
        if (pr.length) np[ex] = pr;
      }
      if (Object.keys(np).length) next.oi[sym] = np;
    }
    for (const [sym, per] of Object.entries(raw.funding || {})) {
      const np: Record<string, Pt[]> = {};
      for (const [ex, arr] of Object.entries(per)) {
        const pr = prunePts(arr, cutoff);
        if (pr.length) np[ex] = pr;
      }
      if (Object.keys(np).length) next.funding[sym] = np;
    }
    next.firstSignal = raw.firstSignal || {};
    next.lastSignalTs = raw.lastSignalTs || {};
    // метки сигналов старше часа не имеют смысла
    const hourAgo = Date.now() - 3600_000;
    for (const [sym, ts] of Object.entries(next.firstSignal)) if (ts < hourAgo) delete next.firstSignal[sym];
    store.series = next;
    const nSym = Object.keys(next.crossSpread).length;
    console.log(`[warmup] series восстановлены: ${nSym} монет с диска (z-score готов сразу)`);
  } catch {
    /* битый файл — стартуем с пустых серий */
  }
}

/** Отложенная запись серий на диск (вызывается после каждого свежего скана). */
export function scheduleSeriesPersist() {
  if (warm.timer || warm.writing) return;
  warm.timer = setTimeout(() => {
    warm.timer = null;
    warm.writing = true;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SERIES_FILE, JSON.stringify(store.series));
    } catch {
      /* диск недоступен — пропускаем цикл */
    } finally {
      warm.writing = false;
    }
  }, PERSIST_DELAY_MS);
  // не держим процесс ради записи
  if (typeof warm.timer === 'object' && warm.timer && 'unref' in warm.timer) warm.timer.unref?.();
}

