import { NextRequest, NextResponse } from 'next/server';
import { loadSnapshotLines } from '@/lib/screener/store';
import { numParam } from '@/lib/screener/params';
import { simulateArb } from '@/lib/screener/arbsim';
import { SCORE_VERSION } from '@/lib/screener/score';
import { HORIZON_MS } from '@/lib/screener/patterns';
import type { ExchangeId } from '@/lib/screener/types';

export const dynamic = 'force-dynamic';

/* Оптимизатор фильтров: перебор сетки порогов по снимкам скана.

   Сделка проводится ОДНИМ выражением с бэктестом и с историей паттернов —
   simulateArb поверх costs.ts. Раньше P&L считался здесь как netEntry - netExit:
   комиссии в этой разности сокращаются (обе величины уже нетто одного пересечения),
   а слипейджа нет вовсе, то есть круг выходил бесплатным. Следствие видно прямо в
   выдаче: сетка всегда выбирала самый мягкий порог — на живом замере 0.15 / скор 0 /
   кулдаун 5 мин, 323 сделки в сутки по +0.136%, при том что симулятор с полными
   издержками на том же типе сделки давал -2.34% на сделку по 148 закрытым позициям.

   Доля сделок, посчитанных без слипейджа, возвращается отдельным полем: это
   допущение, а не измерение, и складывать его в заголовочную цифру нельзя. */

const THRESHOLDS = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6];
const SCORES = [0, 15, 25, 35, 50, 60];
/* Кулдаун короче горизонта оценки превращает один затянувшийся разрыв в несколько
   сделок с перекрывающимися окнами: n растёт, независимых наблюдений не прибавляется,
   а ранжирование по avgPnl x sqrt(decided) вознаграждает ровно это дублирование.
   Поэтому сетка начинается с самого горизонта, а не с 5 минут. */
const HORIZON_MIN = Math.round(HORIZON_MS / 60_000);
const COOLDOWNS = [HORIZON_MIN, HORIZON_MIN * 2, HORIZON_MIN * 4];
const WINDOW_MS = HORIZON_MS;

interface ComboResult {
  threshold: number;
  minScore: number;
  cooldownMin: number;
  /* Сколько точек снимка отброшено как посчитанные ДРУГОЙ шкалой скора. Отброшенное
     молча неотличимо от отсутствующего, поэтому число едет в результате. */
  scaleSkipped: number;
  signals: number;
  decided: number;
  wins: number; // TP
  sls: number; // SL (включая таймауты с минусом)
  timeouts: number;
  winRate: number | null;
  totalPnl: number; // суммарный % на круг по всем сделкам, ПОСЛЕ издержек
  avgPnl: number | null; // матожидание одной сделки, %, ПОСЛЕ издержек
  avgWin: number | null;
  avgLoss: number | null;
  maxDdPct: number; // макс просадка кривой суммарного PnL, п.п.
  tradesPerDay: number;
  /* Сколько решённых сделок посчитано без слипейджа (стакан не измерен либо снимок
     старше поля). На эту долю результат завышен, и завышен в разы: слипейдж круга на
     живом скане порядка 1% против 0.18% комиссий. */
  noSlip: number;
}

interface CacheGlobal {
  /* кэшируем только дорогую часть — прогон сетки по снапшотам (зависит лишь от hours).
     Ранжирование и выбор «текущей» комбинации зависят от параметров запроса и считаются каждый раз. */
  __optimizeCache: { ts: number; hours: number; samples: number; from: number; results: ComboResult[] } | null;
}
const g = globalThis as unknown as CacheGlobal;
if (!g.__optimizeCache) g.__optimizeCache = null;

function runCombo(
  lines: ReturnType<typeof loadSnapshotLines>,
  threshold: number,
  minScore: number,
  cooldownMin: number,
  hours: number
): ComboResult {
  const lastFire = new Map<string, number>();
  let scaleSkipped = 0;
  interface Open {
    ts: number;
    symbol: string;
    entry: number;
    hi: ExchangeId;
    lo: ExchangeId;
    slip: number | null;
    path: Array<{ ts: number; net: number }>;
  }
  const open: Open[] = [];
  let wins = 0, sls = 0, timeouts = 0, decided = 0, signals = 0, noSlip = 0;
  let totalPnl = 0, sumWin = 0, sumLoss = 0, peak = 0, maxDd = 0;

  const close = (o: Open) => {
    const res = simulateArb(o.entry, o.path, o.hi, o.lo, o.slip);
    if (!res) return; // пути нет — это отсутствие данных, а не нулевой исход
    totalPnl += res.pnlPct;
    if (res.win) wins++; else sls++;
    if (res.exit === 'timeout') timeouts++;
    if (!res.slipModeled) noSlip++;
    decided++;
    sumWin += res.pnlPct > 0 ? res.pnlPct : 0;
    sumLoss += res.pnlPct < 0 ? -res.pnlPct : 0;
    peak = Math.max(peak, totalPnl);
    maxDd = Math.max(maxDd, peak - totalPnl);
  };

  for (const line of lines) {
    if (!Array.isArray(line?.pts)) continue; // битая строка снапшота не должна ронять прогон
    const bySymbol = new Map(line.pts.map((p) => [p.s, p]));

    // 1) ведём открытые сделки по текущим котировкам
    for (let i = open.length - 1; i >= 0; i--) {
      const o = open[i];
      const cur = bySymbol.get(o.symbol);
      if (cur) o.path.push({ ts: line.ts, net: cur.net });
      if (line.ts - o.ts > WINDOW_MS) {
        close(o);
        open.splice(i, 1);
      }
    }

    // 2) входы по фильтрам
    for (const p of line.pts) {
      /* Шкала скора сменилась (доля доступного веса вместо суммы слагаемых), и в кольце
         снимков лежат точки двух шкал. Порог по скору, приложенный к обеим сразу,
         отбирает разные множества под одним именем — и результат выглядит штатно.
         Поэтому при minScore > 0 точки чужой шкалы не берутся вовсе, а их число
         возвращается отдельным полем: отброшенное молча неотличимо от отсутствующего.
         При minScore = 0 скор не участвует в отборе, и старые точки остаются годны. */
      if (minScore > 0 && (p.sv ?? 1) !== SCORE_VERSION) {
        scaleSkipped++;
        continue;
      }
      if (p.net < threshold || p.sc < minScore) continue;
      const last = lastFire.get(p.s) || 0;
      if (line.ts - last < cooldownMin * 60_000) continue;
      lastFire.set(p.s, line.ts);
      signals++;
      /* Одна открытая позиция на символ. Прежний лимит в три штуки поверх кулдауна
         означал, что кулдаун не ограничивал перекрытие окон вообще. */
      if (open.some((o) => o.symbol === p.s)) continue;
      open.push({
        ts: line.ts,
        symbol: p.s,
        entry: p.net,
        hi: p.hi,
        lo: p.lo,
        slip: typeof p.slip === 'number' ? p.slip : null,
        path: [],
      });
    }
  }
  // незакрытые на конце истории — не считаются (не decided)

  return {
    threshold,
    minScore,
    cooldownMin,
    scaleSkipped,
    signals,
    decided,
    wins,
    sls,
    timeouts,
    winRate: decided ? wins / decided : null,
    totalPnl: Number(totalPnl.toFixed(2)),
    avgPnl: decided ? Number((totalPnl / decided).toFixed(3)) : null,
    avgWin: wins ? Number((sumWin / wins).toFixed(3)) : null,
    avgLoss: sls ? Number((-sumLoss / sls).toFixed(3)) : null,
    maxDdPct: Number(maxDd.toFixed(2)),
    tradesPerDay: Number(((decided * 24) / Math.max(1, hours)).toFixed(1)),
    noSlip,
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const hours = numParam(sp, 'hours', 24, 2, 48);
  const minDecided = numParam(sp, 'minDecided', 8, 3);
  const curThreshold = numParam(sp, 'threshold', 0.25, 0.05);
  const curScore = numParam(sp, 'minScore', 0, 0);
  const curCooldown = numParam(sp, 'cooldownMin', HORIZON_MIN, 1);

  // читаем кэш на каждом запросе: значение globalThis меняется, ссылка времени импорта — нет
  const cached = g.__optimizeCache;
  let results: ComboResult[];
  let samples: number;
  let from: number;

  if (cached && cached.hours === hours && Date.now() - cached.ts < 5 * 60_000) {
    results = cached.results;
    samples = cached.samples;
    from = cached.from;
  } else {
    const lines = loadSnapshotLines(hours);
    if (lines.length < 30) {
      return NextResponse.json({
        hours,
        samples: lines.length,
        message: 'мало истории снапшотов: нужно ≥30 циклов скана (~25 минут работы), статистика набирается',
        best: [],
        current: null,
      });
    }
    results = [];
    for (const th of THRESHOLDS) {
      for (const sc of SCORES) {
        for (const cd of COOLDOWNS) {
          results.push(runCombo(lines, th, sc, cd, hours));
        }
      }
    }
    samples = lines.length;
    from = lines[0].ts;
    g.__optimizeCache = { ts: Date.now(), hours, samples, from, results };
  }

  // ранжирование: матожидание × значимость (√числа сделок)
  const rank = (r: ComboResult) => (r.avgPnl != null ? r.avgPnl * Math.sqrt(Math.max(1, r.decided)) : -99);
  const eligible = results.filter((r) => r.decided >= minDecided);
  // копия перед сортировкой: `results` может быть массивом из кэша, его нельзя переупорядочивать
  const best = [...(eligible.length ? eligible : results)].sort((a, b) => rank(b) - rank(a)).slice(0, 6);

  const nearTh = THRESHOLDS.reduce((p, c) => (Math.abs(c - curThreshold) < Math.abs(p - curThreshold) ? c : p), THRESHOLDS[0]);
  const nearSc = SCORES.includes(curScore) ? curScore : 0;
  const nearCd = COOLDOWNS.includes(curCooldown) ? curCooldown : COOLDOWNS[0];
  const current = results.find((r) => r.threshold === nearTh && r.minScore === nearSc && r.cooldownMin === nearCd) ?? null;

  /* Агрегат по сетке: сколько точек старой шкалы скора отброшено. Комбинации с
     minScore > 0 после смены шкалы остаются без данных, и их decided = 0 неотличим от
     «порог ничего не нашёл» — без этой строки рекомендация «minScore = 0» выглядела бы
     выводом из данных, а не следствием того, что у остальных выборка пуста. */
  const scaleSkippedTotal = results.reduce((a, r) => a + r.scaleSkipped, 0);

  const resp = {
    scaleSkipped: scaleSkippedTotal,
    scaleNote:
      scaleSkippedTotal > 0
        ? `шкала скора сменилась: у комбинаций с minScore > 0 сравнимых точек почти нет (отброшено ${scaleSkippedTotal}), поэтому верх сетки сейчас занят minScore = 0 ПО ОТСУТСТВИЮ АЛЬТЕРНАТИВЫ, а не по измеренному преимуществу. Кольцо снимков перезаполнится за ~36 ч`
        : null,
    hours,
    samples,
    from,
    grid: { thresholds: THRESHOLDS, scores: SCORES, cooldowns: COOLDOWNS },
    best,
    current,
  };
  return NextResponse.json(resp);
}

