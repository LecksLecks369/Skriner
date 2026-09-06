import { NextRequest, NextResponse } from 'next/server';
import { loadSnapshotLines } from '@/lib/screener/store';

export const dynamic = 'force-dynamic';

/* Оптимизатор фильтров: перебор сетки порогов (нетто ≥ / скор ≥ / кулдаун) по снапшотам скана.
   В отличие от бэктеста (win = сошёлся вдвое), здесь эмулируется сделка с правилами paper-трейдинга:
   TP — нетто сжалось до max(0.05%, 35% входа); SL — нетто выросло на 0.25%; таймаут 30м — выход по текущему.
   PnL сделки = netEntry − netExit (% на круг). Итог: топ-комбинации по матожиданию с учётом значимости. */

const THRESHOLDS = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6];
const SCORES = [0, 15, 25, 35, 50, 60];
const COOLDOWNS = [5, 10, 20];
const SL_ADD = 0.25; // % — насколько разрыв должен вырасти против нас
const WINDOW_MS = 30 * 60 * 1000;

interface ComboResult {
  threshold: number;
  minScore: number;
  cooldownMin: number;
  signals: number;
  decided: number;
  wins: number; // TP
  sls: number; // SL (включая таймауты с минусом)
  timeouts: number;
  winRate: number | null;
  totalPnl: number; // суммарный % на круг по всем сделкам
  avgPnl: number | null; // матожидание одной сделки, %
  avgWin: number | null;
  avgLoss: number | null;
  maxDdPct: number; // макс просадка кривой суммарного PnL, п.п.
  tradesPerDay: number;
}

interface CacheGlobal {
  __optimizeCache: { ts: number; hours: number; result: unknown } | null;
}
const g = globalThis as unknown as CacheGlobal;
if (!g.__optimizeCache) g.__optimizeCache = null;
const mem = g.__optimizeCache;

function runCombo(
  lines: ReturnType<typeof loadSnapshotLines>,
  threshold: number,
  minScore: number,
  cooldownMin: number,
  hours: number
): ComboResult {
  const lastFire = new Map<string, number>();
  interface Open {
    ts: number;
    entry: number;
    tp: number;
    sl: number;
    done: boolean;
  }
  const open = new Map<string, Open[]>();
  let wins = 0, sls = 0, timeouts = 0, decided = 0, signals = 0;
  let totalPnl = 0, sumWin = 0, sumLoss = 0, peak = 0, maxDd = 0;

  const settle = (pnl: number, kind: 'tp' | 'sl' | 'timeout') => {
    totalPnl += pnl;
    if (pnl >= 0) wins++; else sls++;
    if (kind === 'timeout') timeouts++;
    decided++;
    sumWin += pnl > 0 ? pnl : 0;
    sumLoss += pnl < 0 ? -pnl : 0;
    peak = Math.max(peak, totalPnl);
    maxDd = Math.max(maxDd, peak - totalPnl);
  };

  for (const line of lines) {
    // 1) закрытие открытых сделок по текущим ценам
    for (const [sym, arr] of open) {
      const cur = line.pts.find((p) => p.s === sym);
      const netNow = cur ? cur.net : null;
      for (const o of arr) {
        if (o.done) continue;
        if (line.ts - o.ts > WINDOW_MS) {
          const exit = netNow != null ? netNow : o.entry; // монета пропала со скана — по входу
          settle(o.entry - exit, 'timeout');
          o.done = true;
          continue;
        }
        if (netNow == null) continue;
        if (netNow <= o.tp) {
          settle(o.entry - netNow, 'tp'); // выход по фактическому сжатию
          o.done = true;
        } else if (netNow >= o.sl) {
          settle(o.entry - netNow, 'sl');
          o.done = true;
        }
      }
      open.set(sym, arr.filter((o) => !o.done));
      if (!open.get(sym)!.length) open.delete(sym);
    }

    // 2) входы по фильтрам
    for (const p of line.pts) {
      if (p.net < threshold || p.sc < minScore) continue;
      const last = lastFire.get(p.s) || 0;
      if (line.ts - last < cooldownMin * 60_000) continue;
      lastFire.set(p.s, line.ts);
      signals++;
      const arr = open.get(p.s) || [];
      if (arr.length < 3) {
        arr.push({ ts: line.ts, entry: p.net, tp: Math.max(0.05, p.net * 0.35), sl: p.net + SL_ADD, done: false });
        open.set(p.s, arr);
      }
    }
  }
  // незакрытые на конце истории — не считаются (не decided)

  return {
    threshold,
    minScore,
    cooldownMin,
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
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const hours = Math.min(48, Math.max(2, parseFloat(sp.get('hours') || '24') || 24));
  const minDecided = Math.max(3, parseFloat(sp.get('minDecided') || '8') || 8);
  const curThreshold = Math.max(0.05, parseFloat(sp.get('threshold') || '0.25') || 0.25);
  const curScore = Math.max(0, parseFloat(sp.get('minScore') || '0') || 0);
  const curCooldown = Math.max(1, parseFloat(sp.get('cooldownMin') || '10') || 10);

  if (mem && mem.hours === hours && Date.now() - mem.ts < 5 * 60_000) {
    return NextResponse.json(mem.result as Record<string, unknown>);
  }

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

  const results: ComboResult[] = [];
  for (const th of THRESHOLDS) {
    for (const sc of SCORES) {
      for (const cd of COOLDOWNS) {
        results.push(runCombo(lines, th, sc, cd, hours));
      }
    }
  }

  // ранжирование: матожидание × значимость (√числа сделок)
  const rank = (r: ComboResult) => (r.avgPnl != null ? r.avgPnl * Math.sqrt(Math.max(1, r.decided)) : -99);
  const eligible = results.filter((r) => r.decided >= minDecided);
  const best = (eligible.length ? eligible : results).sort((a, b) => rank(b) - rank(a)).slice(0, 6);

  const nearTh = THRESHOLDS.reduce((p, c) => (Math.abs(c - curThreshold) < Math.abs(p - curThreshold) ? c : p), THRESHOLDS[0]);
  const nearSc = SCORES.includes(curScore) ? curScore : 0;
  const nearCd = COOLDOWNS.includes(curCooldown) ? curCooldown : 10;
  const current = results.find((r) => r.threshold === nearTh && r.minScore === nearSc && r.cooldownMin === nearCd) ?? null;

  const resp = {
    hours,
    samples: lines.length,
    from: lines[0].ts,
    grid: { thresholds: THRESHOLDS, scores: SCORES, cooldowns: COOLDOWNS },
    best,
    current,
  };
  g.__optimizeCache = { ts: Date.now(), hours, result: resp };
  return NextResponse.json(resp);
}

