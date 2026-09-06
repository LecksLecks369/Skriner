import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import type { PaperTrade } from '@/lib/screener/types';

export const dynamic = 'force-dynamic';

/* Paper-трейдинг: виртуальные спред-сделки. Хранение — data/paper_trades.json (персистентно). */

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'paper_trades.json');

interface PaperGlobal {
  __screenerPaper: { trades: PaperTrade[]; loaded: boolean };
}
const g = globalThis as unknown as PaperGlobal;
if (!g.__screenerPaper) g.__screenerPaper = { trades: [], loaded: false };
const store = g.__screenerPaper;

function load(): PaperTrade[] {
  if (store.loaded) return store.trades;
  store.loaded = true;
  try {
    if (fs.existsSync(FILE)) {
      store.trades = JSON.parse(fs.readFileSync(FILE, 'utf8')) as PaperTrade[];
    }
  } catch {
    store.trades = [];
  }
  return store.trades;
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store.trades, null, 0));
  } catch {
    /* диск недоступен — держим в памяти */
  }
}

export async function GET() {
  const trades = load().slice().reverse(); // новые сверху
  const open = trades.filter((t) => t.status === 'open');
  const closed = trades.filter((t) => t.status === 'closed');
  const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0.005).length;

  /* -------- P&L-аналитика: реальное матожидание стратегии -------- */
  const closedSorted = closed.filter((t) => t.pnlPct != null).sort((a, b) => (a.closedTs ?? a.ts) - (b.closedTs ?? b.ts));
  const pnls = closedSorted.map((t) => t.pnlPct!);
  const winsArr = pnls.filter((p) => p > 0);
  const lossesArr = pnls.filter((p) => p <= 0);
  const grossWin = winsArr.reduce((s, p) => s + p, 0);
  const grossLoss = lossesArr.reduce((s, p) => s + Math.abs(p), 0);
  // equity curve: кумулятивный PnL по времени закрытия
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  const equity = closedSorted.map((t) => {
    cum += t.pnlPct!;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    return { ts: t.closedTs ?? t.ts, cum: Number(cum.toFixed(3)) };
  });
  // серии побед/поражений
  let curStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  for (const p of pnls) {
    if (p > 0) curStreak = curStreak > 0 ? curStreak + 1 : 1;
    else curStreak = curStreak < 0 ? curStreak - 1 : -1;
    maxWinStreak = Math.max(maxWinStreak, curStreak);
    maxLossStreak = Math.max(maxLossStreak, -curStreak);
  }
  const byRoute = new Map<string, { n: number; pnl: number; wins: number }>();
  const byReason = new Map<string, { n: number; pnl: number }>();
  let holdSum = 0, holdN = 0;
  for (const t of closedSorted) {
    const rk = `${t.buyEx}->${t.sellEx}`;
    const r = byRoute.get(rk) || { n: 0, pnl: 0, wins: 0 };
    r.n++; r.pnl += t.pnlPct!; if (t.pnlPct! > 0) r.wins++;
    byRoute.set(rk, r);
    const k = t.closeReason || 'manual';
    const rr = byReason.get(k) || { n: 0, pnl: 0 };
    rr.n++; rr.pnl += t.pnlPct!;
    byReason.set(k, rr);
    if (t.closedTs) { holdSum += (t.closedTs - t.ts) / 60000; holdN++; }
  }
  const sortedByPnl = [...closedSorted].sort((a, b) => (b.pnlPct ?? 0) - (a.pnlPct ?? 0));
  // сколько закрытых сделок посчитано без стакана — на эту долю статистика оптимистична
  const unmodeled = closedSorted.filter((t) => !t.slipModeled).length;
  const analytics = {
    slipUnmodeled: unmodeled,
    slipUnmodeledPct: closedSorted.length ? Number((unmodeled / closedSorted.length).toFixed(2)) : null,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? null : 0,
    expectancy: pnls.length ? Number((pnls.reduce((s, p) => s + p, 0) / pnls.length).toFixed(3)) : null,
    avgWin: winsArr.length ? Number((grossWin / winsArr.length).toFixed(3)) : null,
    avgLoss: lossesArr.length ? Number((-grossLoss / lossesArr.length).toFixed(3)) : null,
    maxDdPct: Number(maxDd.toFixed(2)),
    equity,
    maxWinStreak,
    maxLossStreak,
    avgHoldMin: holdN ? Number((holdSum / holdN).toFixed(1)) : null,
    best: sortedByPnl.length ? { symbol: sortedByPnl[0].symbol, pnl: sortedByPnl[0].pnlPct! } : null,
    worst: sortedByPnl.length ? { symbol: sortedByPnl[sortedByPnl.length - 1].symbol, pnl: sortedByPnl[sortedByPnl.length - 1].pnlPct! } : null,
    byReason: Object.fromEntries([...byReason.entries()].map(([k, v]) => [k, { n: v.n, pnl: Number(v.pnl.toFixed(2)) }])),
    byRoute: Object.fromEntries(
      [...byRoute.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 8)
        .map(([k, v]) => [k, { n: v.n, pnl: Number(v.pnl.toFixed(2)), winRate: Number((v.wins / v.n).toFixed(2)) }])
    ),
  };

  return NextResponse.json({
    trades: trades.slice(0, 120),
    stats: {
      open: open.length,
      closed: closed.length,
      wins,
      winRate: closed.length ? wins / closed.length : null,
      avgPnl: closed.length ? closed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / closed.length : null,
      totalPnl: closed.reduce((s, t) => s + (t.pnlPct ?? 0), 0),
    },
    analytics,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<PaperTrade> & { action?: string; id?: string; netExit?: number; reason?: PaperTrade['closeReason'] };
    const trades = load();

    if (body.action === 'clear') {
      store.trades = trades.filter((t) => t.status === 'open');
      save();
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'close' && body.id) {
      const tr = trades.find((x) => x.id === body.id && x.status === 'open');
      if (!tr) return NextResponse.json({ error: 'сделка не найдена' }, { status: 404 });
      // netExit обязателен и должен быть числом: молчаливый 0 записал бы фиктивный «полный выигрыш»
      if (typeof body.netExit !== 'number' || !Number.isFinite(body.netExit)) {
        return NextResponse.json({ error: 'netExit обязателен и должен быть числом' }, { status: 400 });
      }
      tr.status = 'closed';
      tr.closedTs = Date.now();
      tr.netExit = body.netExit;
      const gross = tr.netEntry - tr.netExit;
      tr.pnlGrossPct = Number(gross.toFixed(4));
      /* Симулятор обязан «проедать стакан»: круг пересекает обе книги дважды —
         на входе (покупка+продажа) и на выходе (обратные ноги). slipRoundTripPct —
         стоимость одного такого пересечения, поэтому вычитаем её дважды.
         Если стакана на входе не было (slipModeled=false) — P&L остаётся валовым
         и завышенным ровно на величину неучтённого проскальзывания. */
      const slipCost = tr.slipRoundTripPct != null ? tr.slipRoundTripPct * 2 : 0;
      tr.pnlPct = Number((gross - slipCost).toFixed(4));
      tr.closeReason = body.reason || 'manual';
      save();
      return NextResponse.json({ ok: true, trade: tr });
    }

    // open
    if (!body.symbol || !body.buyEx || !body.sellEx || body.pBuy == null || body.pSell == null || body.netEntry == null) {
      return NextResponse.json({ error: 'неполные данные сделки' }, { status: 400 });
    }
    // глубина стакана на входе: без неё P&L считается по цене спреда, как будто
    // позиция любого размера исполняется по топу книги
    const slipRt =
      typeof body.slipRoundTripPct === 'number' && Number.isFinite(body.slipRoundTripPct) && body.slipRoundTripPct >= 0
        ? Number(body.slipRoundTripPct.toFixed(4))
        : null;
    const trade: PaperTrade = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      symbol: body.symbol,
      buyEx: body.buyEx,
      sellEx: body.sellEx,
      pBuy: body.pBuy,
      pSell: body.pSell,
      netEntry: Number(body.netEntry.toFixed(4)),
      score: body.score ?? 0,
      status: 'open',
      sizeUsd: typeof body.sizeUsd === 'number' && Number.isFinite(body.sizeUsd) ? body.sizeUsd : undefined,
      slipRoundTripPct: slipRt ?? undefined,
      slipModeled: slipRt != null,
    };
    trades.push(trade);
    if (trades.length > 500) store.trades = trades.slice(-500);
    save();
    return NextResponse.json({ ok: true, trade });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'paper failed' }, { status: 500 });
  }
}

