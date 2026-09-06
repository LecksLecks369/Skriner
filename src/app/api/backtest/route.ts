import { NextRequest, NextResponse } from 'next/server';
import { loadSnapshotLines } from '@/lib/screener/store';
import { numParam } from '@/lib/screener/params';

export const dynamic = 'force-dynamic';

interface BtSignal {
  ts: number;
  symbol: string;
  net: number;
  outcome: 'win' | 'loss' | 'pending';
}

/**
 * Бэктест фильтров по снапшотам скана (кольцевой файл ~36ч).
 * Сигнал: нетто-спред ≥ threshold И скор ≥ minScore, с кулдауном на монету.
 * Исход: спред сошёлся вдвое за 30 минут (win) — как в журнале.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const threshold = numParam(sp, 'threshold', 0.25, 0.05);
  const minScore = numParam(sp, 'minScore', 0, 0);
  const hours = numParam(sp, 'hours', 24, 1, 48);
  const cooldownMin = numParam(sp, 'cooldownMin', 10, 1);
  const windowMs = 30 * 60 * 1000;

  const lines = loadSnapshotLines(hours);
  const now = Date.now();
  const lastFire = new Map<string, number>();
  const pending = new Map<string, Array<{ ts: number; pBuy: number; pSell: number; gap: number; outcomeSet?: boolean }>>();
  const signals: BtSignal[] = [];

  for (const line of lines) {
    const bySymbol = new Map<string, { pBuy: number; pSell: number }>();
    for (const p of line.pts) bySymbol.set(p.s, { pBuy: p.pBuy, pSell: p.pSell });

    // 1) разрешаем ожидающие исходы по текущим ценам
    for (const [sym, arr] of pending) {
      const cur = bySymbol.get(sym);
      if (!cur) continue;
      const gapNow = cur.pSell > 0 ? (cur.pSell - cur.pBuy) / cur.pBuy : 0;
      for (const o of arr) {
        if (line.ts - o.ts > windowMs || o.outcomeSet) continue;
        const sig = signals.find((x) => x.ts === o.ts && x.symbol === sym);
        if (sig && sig.outcome === 'pending') {
          sig.outcome = gapNow <= o.gap * 0.5 ? 'win' : 'loss';
          o.outcomeSet = true;
        }
      }
      pending.set(sym, arr.filter((o) => line.ts - o.ts <= windowMs && !o.outcomeSet));
    }

    // 2) генерируем сигналы по фильтрам
    for (const p of line.pts) {
      if (p.net < threshold || p.sc < minScore) continue;
      const last = lastFire.get(p.s) || 0;
      if (line.ts - last < cooldownMin * 60_000) continue;
      lastFire.set(p.s, line.ts);
      const gap = p.pBuy > 0 ? (p.pSell - p.pBuy) / p.pBuy : 0;
      signals.push({ ts: line.ts, symbol: p.s, net: Number(p.net.toFixed(3)), outcome: 'pending' });
      const arr = pending.get(p.s) || [];
      arr.push({ ts: line.ts, pBuy: p.pBuy, pSell: p.pSell, gap });
      pending.set(p.s, arr.slice(-5));
    }
  }

  const decided = signals.filter((x) => x.outcome !== 'pending');
  const wins = decided.filter((x) => x.outcome === 'win').length;
  const avgNet = signals.length ? signals.reduce((s, x) => s + x.net, 0) / signals.length : 0;

  return NextResponse.json({
    hours,
    threshold,
    minScore,
    cooldownMin,
    samples: lines.length,
    from: lines.length ? lines[0].ts : now,
    signals: signals.length,
    decided: decided.length,
    wins,
    losses: decided.length - wins,
    winRate: decided.length ? wins / decided.length : null,
    avgNet: Number(avgNet.toFixed(3)),
    recent: signals.slice(-20).reverse(),
  });
}

