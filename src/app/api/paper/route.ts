import { NextRequest, NextResponse } from 'next/server';
import type { PaperTrade } from '@/lib/screener/types';
import { closePaperTrade, loadPaper, openPaperTrade, setPaperTrades } from '@/lib/screener/paper';
import { computeEdge } from '@/lib/screener/edge';

export const dynamic = 'force-dynamic';

/* Paper-трейдинг: виртуальные спред-сделки. Хранилище и правила закрытия — в lib/screener/paper.ts,
   там же автопилот, который ведёт сделки на сервере. Роут — только HTTP-обёртка над ним:
   пока склад был локальным для роута, ручные сделки и автопилот писали в разные копии списка. */

const load = loadPaper;

export async function GET() {
  const trades = load().slice().reverse(); // новые сверху
  const open = trades.filter((t) => t.status === 'open');
  const closed = trades.filter((t) => t.status === 'closed');
  /* Победа — ровно то же условие, что в edge.ts: pnlPct > 0. Раньше здесь стоял
     порог 0.005%, и в одном ответе ехали два разных определения победы, одно в
     stats.winRate, другое в analytics.edge.winRate. Сделки без pnlPct — отсутствие
     данных, а не ноль: они не попадают ни в числитель, ни в знаменатель. */
  const closedWithPnl = closed.filter((t) => t.pnlPct != null);
  const wins = closedWithPnl.filter((t) => t.pnlPct! > 0).length;

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
  /* Матожидание с доверительным интервалом: без интервала средний P&L на десятке сделок
     читается как факт. Вердикт тот же, что у паттернов, — по положению нуля в интервале. */
  /* Символ каждой сделки — независимая единица наблюдения. Без него интервал
     ресэмплит строки, а строки одного символа коррелированы: в окне оценки 60
     сделок пришли с 24 символов, и один давал 10 из них. Кластерный бутстрэп был
     заведён в edge.ts ровно для этого, но подключён только на стороне паттернов. */
  const edge = computeEdge(pnls, closedSorted.map((t) => t.symbol));
  const analytics = {
    edge,
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
      /* Знаменатель — сделки С результатом, а не все закрытые: закрытая сделка без
         pnlPct не «нулевая», она неизмеренная, и деление на неё разбавляло и
         win-rate, и среднее, расходясь с analytics.expectancy на той же выборке. */
      closedWithPnl: closedWithPnl.length,
      wins,
      winRate: closedWithPnl.length ? wins / closedWithPnl.length : null,
      avgPnl: closedWithPnl.length ? closedWithPnl.reduce((s, t) => s + t.pnlPct!, 0) / closedWithPnl.length : null,
      totalPnl: closedWithPnl.reduce((s, t) => s + t.pnlPct!, 0),
    },
    analytics,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<PaperTrade> & { action?: string; id?: string; netExit?: number; reason?: PaperTrade['closeReason'] };
    const trades = load();

    if (body.action === 'clear') {
      setPaperTrades(trades.filter((t) => t.status === 'open'));
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'close' && body.id) {
      // netExit обязателен и должен быть числом: молчаливый 0 записал бы фиктивный «полный выигрыш»
      if (typeof body.netExit !== 'number' || !Number.isFinite(body.netExit)) {
        return NextResponse.json({ error: 'netExit обязателен и должен быть числом' }, { status: 400 });
      }
      const tr = closePaperTrade(body.id, body.netExit, body.reason || 'manual');
      if (!tr) return NextResponse.json({ error: 'сделка не найдена' }, { status: 404 });
      return NextResponse.json({ ok: true, trade: tr });
    }

    // open
    if (!body.symbol || !body.buyEx || !body.sellEx || body.pBuy == null || body.pSell == null || body.netEntry == null) {
      return NextResponse.json({ error: 'неполные данные сделки' }, { status: 400 });
    }
    /* глубина стакана на входе передаётся вызывающим: без неё P&L считается по цене
       спреда, как будто позиция любого размера исполняется по топу книги */
    const trade = openPaperTrade({
      symbol: body.symbol,
      buyEx: body.buyEx,
      sellEx: body.sellEx,
      pBuy: body.pBuy,
      pSell: body.pSell,
      netEntry: body.netEntry,
      score: body.score,
      sizeUsd: body.sizeUsd,
      slipRoundTripPct: body.slipRoundTripPct,
      // нетто-фандинг обеих ног, %/час: стоимость удержания, а не входа
      fundingHourlyPct: body.fundingHourlyPct,
    });
    return NextResponse.json({ ok: true, trade });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'paper failed' }, { status: 500 });
  }
}

