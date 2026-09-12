'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoinRow, PaperTrade, ScanResponse } from '@/lib/screener/types';
import { EX_MAP } from './format';
import { netSpreadForPair } from '@/lib/screener/pair';
import { arbPnlPct, arbTotalCostPct } from '@/lib/screener/costs';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';

/* Панель paper-трейдинга: список сделок, статистика, авто-закрытие по текущему скану.
   TP: P&L после издержек круга дошёл до цели — единственный выход, который считается прибылью.
   «сошёлся»: разрыв сжался до max(0.05%, 35% от входа), но прибыли нет — эджа не осталось.
   SL: нетто выросло ещё на 0.25% и более — разрыв расширился против нас.

   P&L открытой сделки показывается тоже за вычетом издержек: раньше здесь стояло
   netEntry − live, и открытая позиция выглядела прибыльной ровно на стоимость круга. */

interface PaperStats {
  open: number;
  closed: number;
  wins: number;
  winRate: number | null;
  avgPnl: number | null;
  totalPnl: number;
}

interface Analytics {
  /* Матожидание с интервалом: то же, что в карточках паттернов — вердикт по положению нуля */
  edge?: {
    n: number;
    expectancyPct: number | null;
    ciLoPct: number | null;
    ciHiPct: number | null;
    verdict: 'insufficient' | 'negative' | 'inconclusive' | 'positive';
    reason: string;
  };
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  maxDdPct: number;
  equity: Array<{ ts: number; cum: number }>;
  maxWinStreak: number;
  maxLossStreak: number;
  avgHoldMin: number | null;
  best: { symbol: string; pnl: number } | null;
  worst: { symbol: string; pnl: number } | null;
  byReason: Record<string, { n: number; pnl: number }>;
  byRoute: Record<string, { n: number; pnl: number; winRate: number }>;
}

/* Кривая капитала: SVG-полилиния по кумулятивному PnL закрытых сделок */
function EquityCurve({ points }: { points: Array<{ ts: number; cum: number }> }) {
  if (points.length < 2) return null;
  const W = 560;
  const H = 72;
  const pad = 4;
  const vals = points.map((p) => p.cum);
  const min = Math.min(0, ...vals);
  const max = Math.max(0.01, ...vals);
  const range = max - min || 1;
  const step = (W - pad * 2) / (points.length - 1);
  const y = (v: number) => pad + (H - pad * 2) * (1 - (v - min) / range);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(pad + i * step).toFixed(1)},${y(p.cum).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1];
  const zeroY = y(0);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase text-zinc-600">
        <span>кривая капитала (кумулятивный P&L, %)</span>
        <span className={`font-mono tabular-nums normal-case ${last >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {last >= 0 ? '+' : ''}{last.toFixed(2)}%
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[72px] w-full">
        <line x1={pad} x2={W - pad} y1={zeroY} y2={zeroY} stroke="rgb(82 82 91)" strokeDasharray="3 3" strokeWidth="1" />
        <path d={d} fill="none" stroke={last >= 0 ? 'rgb(52 211 153)' : 'rgb(251 113 133)'} strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function PaperPanel({ scan }: { scan: ScanResponse | null }) {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [stats, setStats] = useState<PaperStats | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  /* Карта строк выводится из scan через useMemo, а не копится в рефе. Реф
     заполнялся эффектом, а таблица читала его В РЕНДЕРЕ: эффект выполняется
     ПОСЛЕ рендера, поэтому колонка «сейчас» показывала предыдущий скан, а
     мутация рефа ре-рендер не вызывает — при неизменном списке сделок цифра
     могла не обновиться вовсе. */
  const closingRef = useRef<Set<string>>(new Set());

  const load = useCallback(() => {
    void fetch('/api/paper', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { trades: PaperTrade[]; stats: PaperStats; analytics?: Analytics }) => {
        setTrades(j.trades || []);
        setStats(j.stats || null);
        setAnalytics(j.analytics ?? null);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, [load]);

  const close = useCallback(
    async (id: string, netExit: number, reason: PaperTrade['closeReason'], silent = false) => {
      if (closingRef.current.has(id)) return;
      closingRef.current.add(id);
      try {
        await fetch('/api/paper', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'close', id, netExit, reason }),
        });
        load();
        if (!silent) toast({ title: 'Сделка закрыта', description: `нетто на выходе ${netExit.toFixed(2)}%`, duration: 5000 });
      } finally {
        closingRef.current.delete(id);
      }
    },
    [load]
  );

  /* TP/SL и таймаут считает сервер на каждом скане (lib/screener/paper.ts) — здесь
     только держим карту строк для ручного закрытия и живого P&L. Раньше сопровождение жило в
     эффекте, то есть работало лишь пока открыта вкладка; теперь дублировать его нельзя —
     два закрывающих контура по одним и тем же порогам просто гоняются за одной сделкой. */
  const rows = useMemo(
    () => new Map<string, CoinRow>((scan?.rows ?? []).map((r) => [r.symbol, r])),
    [scan]
  );

  const manualClose = async (t: PaperTrade) => {
    const row = rows.get(t.symbol);
    const cur = row ? netSpreadForPair(row, t.buyEx, t.sellEx) : null;
    await close(t.id, cur ?? t.netEntry, 'manual');
  };

  const clearClosed = async () => {
    await fetch('/api/paper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear' }),
    });
    load();
  };

  return (
    <div className="space-y-3 p-3 sm:p-5">
      <div className="grid grid-cols-3 gap-2 text-center sm:max-w-lg sm:grid-cols-5">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
          <div className="text-[10px] uppercase text-zinc-600">открыто</div>
          <div className="font-mono text-lg tabular-nums text-sky-400">{stats?.open ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
          <div className="text-[10px] uppercase text-zinc-600">закрыто</div>
          <div className="font-mono text-lg tabular-nums text-zinc-100">{stats?.closed ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
          <div className="text-[10px] uppercase text-zinc-600">win-rate</div>
          <div className="font-mono text-lg tabular-nums text-emerald-400">
            {stats?.winRate != null ? `${Math.round(stats.winRate * 100)}%` : '—'}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
          <div className="text-[10px] uppercase text-zinc-600">средний P&L</div>
          <div className={`font-mono text-lg tabular-nums ${(stats?.avgPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {stats?.avgPnl != null ? `${stats.avgPnl >= 0 ? '+' : ''}${stats.avgPnl.toFixed(2)}%` : '—'}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
          <div className="text-[10px] uppercase text-zinc-600">суммарно</div>
          <div className={`font-mono text-lg tabular-nums ${(stats?.totalPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {stats ? `${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)}%` : '—'}
          </div>
        </div>
      </div>

      {/* P&L-аналитика: реальное матожидание */}
      {analytics && analytics.equity.length >= 2 && (
        <div className="grid grid-cols-2 gap-2 text-center sm:max-w-lg sm:grid-cols-3">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
            <div className="text-[10px] uppercase text-zinc-600" title="Сумма прибылей / сумма убытков. >1.5 — стратегия платит">профит-фактор</div>
            <div className={`font-mono text-lg tabular-nums ${(analytics.profitFactor ?? 0) >= 1.5 ? 'text-emerald-400' : (analytics.profitFactor ?? 0) >= 1 ? 'text-amber-400' : 'text-rose-400'}`}>
              {analytics.profitFactor != null ? analytics.profitFactor.toFixed(2) : '∞'}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
            <div className="text-[10px] uppercase text-zinc-600" title="Средний P&L одной сделки — что даёт стратегия на круг">матожидание</div>
            <div className={`font-mono text-lg tabular-nums ${(analytics.expectancy ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {analytics.expectancy != null ? `${analytics.expectancy >= 0 ? '+' : ''}${analytics.expectancy.toFixed(3)}%` : '—'}
            </div>
            {analytics.edge?.ciLoPct != null && analytics.edge.ciHiPct != null && (
              <div className="mt-0.5 font-mono text-[10px] tabular-nums text-zinc-600" title={analytics.edge.reason}>
                95% [{analytics.edge.ciLoPct.toFixed(3)}; {analytics.edge.ciHiPct.toFixed(3)}] · n={analytics.edge.n}
              </div>
            )}
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
            <div className="text-[10px] uppercase text-zinc-600" title="Макс просадка кривой капитала">макс. просадка</div>
            <div className="font-mono text-lg tabular-nums text-rose-400">-{analytics.maxDdPct.toFixed(2)}%</div>
          </div>
        </div>
      )}
      {analytics && analytics.equity.length >= 2 && (
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-[280px] flex-1">
            <EquityCurve points={analytics.equity} />
          </div>
          <div className="min-w-[220px] flex-1 space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 text-[11px] text-zinc-400">
            <div className="flex justify-between"><span>средняя прибыль</span><b className="font-mono tabular-nums text-emerald-400">{analytics.avgWin != null ? `+${analytics.avgWin.toFixed(3)}%` : '—'}</b></div>
            <div className="flex justify-between"><span>средний убыток</span><b className="font-mono tabular-nums text-rose-400">{analytics.avgLoss != null ? `${analytics.avgLoss.toFixed(3)}%` : '—'}</b></div>
            <div className="flex justify-between"><span>серии побед/убытков</span><b className="font-mono tabular-nums text-zinc-200">{analytics.maxWinStreak} / {analytics.maxLossStreak}</b></div>
            <div className="flex justify-between"><span>среднее время в сделке</span><b className="font-mono tabular-nums text-zinc-200">{analytics.avgHoldMin != null ? `${Math.round(analytics.avgHoldMin)}м` : '—'}</b></div>
            {analytics.best && <div className="flex justify-between"><span>лучшая</span><b className="font-mono tabular-nums text-emerald-400">{analytics.best.symbol.replace(/USDT$/, '')} +{analytics.best.pnl.toFixed(2)}%</b></div>}
            {analytics.worst && <div className="flex justify-between"><span>худшая</span><b className="font-mono tabular-nums text-rose-400">{analytics.worst.symbol.replace(/USDT$/, '')} {analytics.worst.pnl.toFixed(2)}%</b></div>}
            {Object.keys(analytics.byReason).length > 0 && (
              <div className="flex justify-between border-t border-zinc-800 pt-1">
                <span>по выходам</span>
                <b className="font-mono tabular-nums text-zinc-300">
                  {Object.entries(analytics.byReason)
                    .map(
                      ([k, v]) =>
                        `${k === 'tp' ? 'TP' : k === 'sl' ? 'SL' : k === 'converged' ? 'сошёлся' : k === 'timeout' ? 'таймаут' : 'вручн'}: ${v.n} (${v.pnl >= 0 ? '+' : ''}${v.pnl.toFixed(1)}%)`
                    )
                    .join(' · ')}
                </b>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <p className="max-w-xl flex-1 text-[11px] leading-relaxed text-zinc-600">
          Открывай из модалки монеты («+ открыть»). TP — спред сжался до 0.05% (или 35% от входа), SL — расширился
          ещё на 0.25%. P&L = нетто-вход − нетто-выход. Сделки персистентны.
        </p>
        {stats && stats.closed > 0 && (
          <Button size="sm" variant="outline" className="h-7 border-zinc-800 text-xs" onClick={clearClosed}>
            очистить закрытые
          </Button>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full min-w-[680px] text-xs">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-[10px] uppercase text-zinc-600">
              <th className="px-3 py-2 font-medium">время</th>
              <th className="px-3 py-2 font-medium">монета</th>
              <th className="px-3 py-2 font-medium">маршрут</th>
              <th className="px-3 py-2 text-right font-medium">вход</th>
              <th className="px-3 py-2 text-right font-medium">сейчас/выход</th>
              <th className="px-3 py-2 text-right font-medium">P&L</th>
              <th className="px-3 py-2 text-right font-medium">статус</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => {
              const row = rows.get(t.symbol);
              const live = row ? netSpreadForPair(row, t.buyEx, t.sellEx) : null;
              const cur = t.status === 'open' ? live : t.netExit;
              const pnl =
                t.status === 'closed'
                  ? t.pnlPct
                  : live != null
                    ? arbPnlPct(
                        t.netEntry,
                        live,
                        /* та же формула издержек, что у сервера при закрытии, вместе со
                           стоимостью удержания: без неё цифра на экране расходится с
                           журналом тем сильнее, чем дольше висит позиция */
                        arbTotalCostPct(
                          t.buyEx,
                          t.sellEx,
                          t.slipRoundTripPct ?? null,
                          t.fundingHourlyPct,
                          Date.now() - t.ts
                        )
                      )
                    : null;
              return (
                <tr key={t.id} className="border-b border-zinc-900/70">
                  <td className="px-3 py-1.5 tabular-nums text-zinc-500">
                    {new Date(t.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-3 py-1.5 font-semibold text-zinc-200">{t.symbol.replace(/USDT$/, '')}</td>
                  <td className="px-3 py-1.5">
                    <span style={{ color: EX_MAP[t.buyEx]?.color }}>{EX_MAP[t.buyEx]?.name}</span>
                    <span className="text-zinc-600"> → </span>
                    <span style={{ color: EX_MAP[t.sellEx]?.color }}>{EX_MAP[t.sellEx]?.name}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-zinc-300">+{t.netEntry.toFixed(2)}%</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-zinc-400">{cur != null ? `${cur.toFixed(2)}%` : '—'}</td>
                  <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${pnl != null ? (pnl > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-600'}`}>
                    {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%` : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {t.status === 'open' ? (
                      <button className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:text-zinc-200" onClick={() => manualClose(t)}>
                        закрыть
                      </button>
                    ) : (
                      <span className={t.closeReason === 'tp' ? 'text-emerald-400' : t.closeReason === 'sl' ? 'text-rose-400' : 'text-zinc-500'}>
                        {t.closeReason === 'tp'
                          ? 'TP'
                          : t.closeReason === 'sl'
                            ? 'SL'
                            : t.closeReason === 'converged'
                              ? 'сошёлся'
                              : t.closeReason === 'timeout'
                                ? 'таймаут'
                                : 'вручную'}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!trades.length && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-zinc-700">
                  Пока пусто — открой бумажную сделку из модалки монеты
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

