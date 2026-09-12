import { NextRequest, NextResponse } from 'next/server';
import { loadSnapshotLines } from '@/lib/screener/store';
import { numParam } from '@/lib/screener/params';
import { simulateArb, type ArbExit } from '@/lib/screener/arbsim';
import { HORIZON_MS } from '@/lib/screener/patterns';
import type { ExchangeId } from '@/lib/screener/types';

export const dynamic = 'force-dynamic';

interface BtSignal {
  ts: number;
  symbol: string;
  net: number;
  outcome: 'win' | 'loss' | 'pending';
  pnl: number | null;
  exit: ArbExit | null;
  slipModeled: boolean | null;
}

/**
 * Бэктест фильтров по снимкам скана (кольцевой файл ~36ч).
 *
 * Сигнал: нетто-спред ≥ threshold И скор ≥ minScore, с кулдауном на монету.
 *
 * Исход: сделка проводится по пути разрыва тем же правилом выхода и той же моделью
 * издержек, что и симулятор (arbsim.ts → costs.ts). Win = чистый P&L круга > 0.
 *
 * Прежнее правило — «разрыв сошёлся вдвое за 30 минут» — снято, и докстринг больше не
 * утверждает, что оно совпадает с журналом. В журнале это правило было снято ещё на
 * v3 с обоснованием «схлопывание вдвое ничего не говорит о прибыли: круг регулярно
 * стоит дороже разрыва», и фраза «как в журнале» превращала расхождение двух цифр
 * (0.64 против 0.79) в мнимый парадокс вместо повода сверить выражения. Плюс сам
 * знак был перевёрнут: в снимке gap = (ask − bid)/bid, то есть при настоящем разрыве
 * он ОТРИЦАТЕЛЕН, и условие gapNow <= gap*0.5 награждало расхождение, а не схождение.
 *
 * ЧТО ЭТА ЦИФРА НЕ ЕСТЬ: win-rate из вкладки «История». Снимок хранит только лучшую
 * пару бирж на тик, и путь местами меняет пару под ногами (pairDrift) — история
 * паттернов перешла на путь по своей паре именно из-за этого. Здесь данных для этого
 * нет, поэтому величины не сравнимы и не должны складываться.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const threshold = numParam(sp, 'threshold', 0.25, 0.05);
  const minScore = numParam(sp, 'minScore', 0, 0);
  const hours = numParam(sp, 'hours', 24, 1, 48);
  /* Кулдаун не может быть короче горизонта оценки: иначе один затянувшийся разрыв
     пишется как несколько сделок с перекрывающимися окнами, и n растёт, а число
     независимых наблюдений — нет. Нижняя граница берётся из самого горизонта. */
  const horizonMin = Math.round(HORIZON_MS / 60_000);
  const cooldownMin = Math.max(horizonMin, numParam(sp, 'cooldownMin', horizonMin, 1));

  const lines = loadSnapshotLines(hours);
  const now = Date.now();
  const lastFire = new Map<string, number>();
  interface Open {
    sig: BtSignal;
    netEntry: number;
    hi: ExchangeId;
    lo: ExchangeId;
    slip: number | null;
    path: Array<{ ts: number; net: number }>;
  }
  const open: Open[] = [];
  const signals: BtSignal[] = [];
  let noSlip = 0;

  const close = (o: Open) => {
    const res = simulateArb(o.netEntry, o.path, o.hi, o.lo, o.slip);
    if (!res) return; // пути нет — исход не «ноль», а отсутствие данных
    o.sig.outcome = res.win ? 'win' : 'loss';
    o.sig.pnl = res.pnlPct;
    o.sig.exit = res.exit;
    o.sig.slipModeled = res.slipModeled;
    if (!res.slipModeled) noSlip++;
  };

  for (const line of lines) {
    if (!Array.isArray(line?.pts)) continue; // битая строка снапшота не должна ронять роут
    const bySymbol = new Map(line.pts.map((p) => [p.s, p]));

    // 1) ведём открытые сделки по текущим котировкам
    for (let i = open.length - 1; i >= 0; i--) {
      const o = open[i];
      const cur = bySymbol.get(o.sig.symbol);
      if (cur) o.path.push({ ts: line.ts, net: cur.net });
      if (line.ts - o.sig.ts > HORIZON_MS) {
        close(o);
        open.splice(i, 1);
      }
    }

    // 2) генерируем сигналы по фильтрам
    for (const p of line.pts) {
      if (p.net < threshold || p.sc < minScore) continue;
      const last = lastFire.get(p.s) || 0;
      if (line.ts - last < cooldownMin * 60_000) continue;
      lastFire.set(p.s, line.ts);
      const sig: BtSignal = {
        ts: line.ts,
        symbol: p.s,
        net: Number(p.net.toFixed(3)),
        outcome: 'pending',
        pnl: null,
        exit: null,
        slipModeled: null,
      };
      signals.push(sig);
      open.push({
        sig,
        netEntry: p.net,
        hi: p.hi,
        lo: p.lo,
        slip: typeof p.slip === 'number' ? p.slip : null,
        path: [],
      });
    }
  }
  // сделки, чьё окно ещё не истекло к концу файла, остаются pending — их нельзя решать

  const decided = signals.filter((x) => x.outcome !== 'pending');
  const wins = decided.filter((x) => x.outcome === 'win').length;
  const avgNet = signals.length ? signals.reduce((s, x) => s + x.net, 0) / signals.length : 0;
  const pnls = decided.map((x) => x.pnl ?? 0);
  const byExit = decided.reduce<Record<string, number>>((acc, x) => {
    if (x.exit) acc[x.exit] = (acc[x.exit] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    hours,
    threshold,
    minScore,
    cooldownMin,
    horizonMin,
    samples: lines.length,
    from: lines.length ? lines[0].ts : now,
    signals: signals.length,
    decided: decided.length,
    wins,
    losses: decided.length - wins,
    winRate: decided.length ? wins / decided.length : null,
    /* Матожидание круга после издержек — та величина, ради которой сделка делается.
       avgNet рядом оставлен как размер разрыва на входе, это не результат. */
    avgPnl: pnls.length ? Number((pnls.reduce((s, v) => s + v, 0) / pnls.length).toFixed(3)) : null,
    avgNet: Number(avgNet.toFixed(3)),
    byExit,
    /* Сколько решённых сделок посчитано без слипейджа (стакан не был измерен или
       снимок старше поля). Это допущение, а не измерение, поэтому оно едет рядом с
       цифрой, а не внутри неё: на живом скане слипейдж круга — порядка 1% против
       0.18% комиссий, то есть на этой доле результат завышен в разы. */
    noSlip,
    noSlipPct: decided.length ? Number((noSlip / decided.length).toFixed(2)) : null,
    /* Снимок хранит только лучшую пару бирж на тик — путь может менять пару под
       ногами. Величина НЕ совпадает с win-rate «Истории», где путь идёт по своей паре. */
    pairDrift: true,
    recent: signals.slice(-20).reverse(),
  });
}
