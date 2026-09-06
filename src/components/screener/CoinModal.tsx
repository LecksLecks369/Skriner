'use client';

import { useEffect, useState } from 'react';
import type { CoinRow, NetworkInfo, PaperTrade } from '@/lib/screener/types';
import { netSpreadForPair } from '@/lib/screener/pair';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EX_MAP, Sparkline, fmtFunding, fmtPrice, fmtTurnover, spreadColor } from './format';

interface SpreadPoint {
  ts: number;
  v: number;
}

function SpreadChart({ points, threshold }: { points: SpreadPoint[]; threshold: number }) {
  if (points.length < 2) {
    return (
      <div className="flex h-28 items-center justify-center text-xs text-zinc-600">
        История спреда наполняется — проверьте через пару минут
      </div>
    );
  }
  const w = 560;
  const h = 110;
  const max = Math.max(threshold, ...points.map((p) => p.v)) * 1.1;
  const min = 0;
  const range = max - min || 1;
  const pts = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - 2 - ((p.v - min) / range) * (h - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const thrY = h - 2 - ((threshold - min) / range) * (h - 4);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-28 w-full" preserveAspectRatio="none">
      <line x1="0" y1={thrY} x2={w} y2={thrY} stroke="#f59e0b" strokeWidth="1" strokeDasharray="4 3" opacity="0.7" />
      <path d={`M${pts.join(' L')}`} fill="none" stroke="#34d399" strokeWidth="1.6" />
    </svg>
  );
}

/* ---------- ИИ-разбор ---------- */
function AiComment({ symbol }: { symbol: string }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ask = async (force = false) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/ai-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, force }),
      });
      const j = (await r.json()) as { comment?: string; error?: string };
      if (j.comment) setText(j.comment);
      else setErr(j.error || 'не удалось получить разбор');
    } catch {
      setErr('ошибка сети');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-violet-400">🧠 ИИ-разбор сигнала</span>
        <div className="flex gap-1.5">
          {!text && (
            <Button size="sm" variant="outline" className="h-6 border-violet-500/40 px-2 text-[11px] text-violet-300" disabled={busy} onClick={() => ask(false)}>
              {busy ? 'думаю…' : 'разобрать'}
            </Button>
          )}
          {text && (
            <Button size="sm" variant="outline" className="h-6 border-zinc-700 px-2 text-[11px] text-zinc-400" disabled={busy} onClick={() => ask(true)}>
              {busy ? '…' : 'обновить'}
            </Button>
          )}
        </div>
      </div>
      {text && <p className="mt-2 text-xs leading-relaxed text-zinc-300">{text}</p>}
      {err && <p className="mt-2 text-xs text-rose-400">{err}</p>}
    </div>
  );
}

/* ---------- Калькулятор позиции ---------- */
function PositionCalc({ row }: { row: CoinRow }) {
  const [dep, setDep] = useState<number>(() => (typeof window === 'undefined' ? 1000 : parseFloat(window.localStorage.getItem('ms_calc_dep') || '1000') || 1000));
  const [riskPct, setRiskPct] = useState<number>(() => (typeof window === 'undefined' ? 1 : parseFloat(window.localStorage.getItem('ms_calc_risk') || '1') || 1));
  const [lev, setLev] = useState<number>(() => (typeof window === 'undefined' ? 5 : parseFloat(window.localStorage.getItem('ms_calc_lev') || '5') || 5));

  useEffect(() => {
    window.localStorage.setItem('ms_calc_dep', String(dep));
    window.localStorage.setItem('ms_calc_risk', String(riskPct));
    window.localStorage.setItem('ms_calc_lev', String(lev));
  }, [dep, riskPct, lev]);

  if (!row.natrPctMax || !row.bestAsk || !row.bestBid) {
    return <div className="text-xs text-zinc-600">Нет данных NATR для расчёта</div>;
  }
  const entry = row.bestAsk.price; // покупаем там, где дешевле
  const natr = row.natrPctMax;
  const stopPct = natr * 1.5; // стоп 1.5×NATR
  const targetPct = natr * 2.5; // тейк 2.5×NATR
  const riskUsd = (dep * riskPct) / 100;
  const sizeUsd = Math.min(riskUsd / (stopPct / 100), dep * lev);
  const margin = sizeUsd / lev;
  const stopPrice = entry * (1 - stopPct / 100);
  const targetPrice = entry * (1 + targetPct / 100);
  const liqPrice = entry * (1 - 1 / lev);
  const feeRound = sizeUsd * (0.00055 + 0.0005) * 2; // taker круга (грубо)
  const rr = targetPct / stopPct;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-xs font-semibold text-zinc-300">Калькулятор позиции (по ATR)</div>
      <div className="grid grid-cols-3 gap-2">
        <label className="text-[10px] text-zinc-500">
          депозит $
          <Input type="number" value={dep} onChange={(e) => setDep(parseFloat(e.target.value) || 0)} className="mt-0.5 h-6 bg-zinc-900 px-1.5 text-xs tabular-nums" />
        </label>
        <label className="text-[10px] text-zinc-500">
          риск %
          <Input type="number" step="0.5" value={riskPct} onChange={(e) => setRiskPct(parseFloat(e.target.value) || 0)} className="mt-0.5 h-6 bg-zinc-900 px-1.5 text-xs tabular-nums" />
        </label>
        <label className="text-[10px] text-zinc-500">
          плечо ×
          <Input type="number" step="1" value={lev} onChange={(e) => setLev(parseFloat(e.target.value) || 1)} className="mt-0.5 h-6 bg-zinc-900 px-1.5 text-xs tabular-nums" />
        </label>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-zinc-300 sm:grid-cols-3">
        <span>вход: <b>{fmtPrice(entry)}</b></span>
        <span>размер: <b>{Math.round(sizeUsd)}$</b></span>
        <span>маржа: <b>{Math.round(margin)}$</b></span>
        <span className="text-rose-400">стоп: {fmtPrice(stopPrice)} (−{stopPct.toFixed(2)}%)</span>
        <span className="text-emerald-400">тейк: {fmtPrice(targetPrice)} (+{targetPct.toFixed(2)}%)</span>
        <span className="text-amber-400">ликв.: {fmtPrice(liqPrice)}</span>
        <span>R:R = 1:{rr.toFixed(1)}</span>
        <span>риск: {Math.round(riskUsd)}$</span>
        <span>комиссии круга: ≈{feeRound.toFixed(1)}$</span>
      </div>
    </div>
  );
}

/* ---------- Бумажные сделки по монете ---------- */
function PaperSection({ row }: { row: CoinRow }) {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () =>
    void fetch('/api/paper', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { trades: PaperTrade[] }) => setTrades((j.trades || []).filter((t) => t.symbol === row.symbol)))
      .catch(() => undefined);

  useEffect(() => {
    load();
  }, [row.symbol]);

  const open = async () => {
    if (!row.bestBid || !row.bestAsk || row.netSpreadPct == null) return;
    setBusy(true);
    try {
      await fetch('/api/paper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'open',
          symbol: row.symbol,
          buyEx: row.bestAsk.exchange,
          sellEx: row.bestBid.exchange,
          pBuy: row.bestAsk.price,
          pSell: row.bestBid.price,
          netEntry: row.netSpreadPct,
          score: row.score,
        }),
      });
      load();
    } finally {
      setBusy(false);
    }
  };

  const close = async (t: PaperTrade) => {
    setBusy(true);
    try {
      await fetch('/api/paper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // спред считаем по паре бирж самой сделки, а не по текущим лучшим bid/ask монеты;
        // если цен нет — закрываем в ноль по netEntry, иначе netExit=0 дал бы «полный выигрыш»
        body: JSON.stringify({
          action: 'close',
          id: t.id,
          netExit: netSpreadForPair(row, t.buyEx, t.sellEx) ?? t.netEntry,
          reason: 'manual',
        }),
      });
      load();
    } finally {
      setBusy(false);
    }
  };

  const canOpen = row.bestBid && row.bestAsk && row.bestBid.exchange !== row.bestAsk.exchange && row.netSpreadPct != null;

  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-sky-400">📝 Бумажные сделки по {row.symbol.replace(/USDT$/, '')}</span>
        <Button size="sm" variant="outline" className="h-6 border-sky-500/40 px-2 text-[11px] text-sky-300" disabled={busy || !canOpen} onClick={open} title={canOpen ? 'Виртуально купить на дешёвой, продать на дорогой' : 'Нет разрыва между биржами'}>
          + открыть
        </Button>
      </div>
      {trades.length > 0 && (
        <div className="mt-2 space-y-1">
          {trades.slice(0, 5).map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-zinc-500">
                {new Date(t.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · вход {t.netEntry.toFixed(2)}%
              </span>
              {t.status === 'open' ? (
                <>
                  {/* показываем спред тех же ног, по которым сделка и закроется */}
                  <span className="font-mono text-zinc-400">
                    сейчас {(() => {
                      const cur = netSpreadForPair(row, t.buyEx, t.sellEx);
                      return cur != null ? `${cur.toFixed(2)}%` : '—';
                    })()}
                  </span>
                  <button className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:text-zinc-200" disabled={busy} onClick={() => close(t)}>
                    закрыть
                  </button>
                </>
              ) : (
                <span className={`font-mono ${(t.pnlPct ?? 0) > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  P&L {(t.pnlPct ?? 0) >= 0 ? '+' : ''}{(t.pnlPct ?? 0).toFixed(2)}%
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {trades.length === 0 && <p className="mt-1.5 text-[10px] text-zinc-600">Виртуальный спред-трейд: profit = netEntry − netExit. Персистентно.</p>}
    </div>
  );
}

export function CoinModal({
  row,
  threshold,
  onClose,
}: {
  row: CoinRow | null;
  threshold: number;
  onClose: () => void;
}) {
  const [hist, setHist] = useState<SpreadPoint[]>([]);
  const [nets, setNets] = useState<{ networks: NetworkInfo[]; note?: string } | null>(null);

  const symbol = row?.symbol;
  // зависим от символа, а не от identity строки: строка обновляется каждым сканом,
  // и на [row] эти запросы уходили бы заново каждые 30 секунд
  useEffect(() => {
    if (!symbol) return;
    void fetch(`/api/spread-history?symbol=${symbol}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setHist(j.points || []))
      .catch(() => undefined);
    void fetch(`/api/networks?symbol=${symbol}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setNets(j))
      .catch(() => undefined);
  }, [symbol]);

  if (!row) return null;

  return (
    <Dialog open={!!row} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[90vh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-200 sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-3">
            <span className="text-lg">{row.symbol}</span>
            <span className="font-mono text-sm text-zinc-400">{fmtPrice(row.price)}</span>
            <span className={`font-mono text-sm ${spreadColor(row.netSpreadPct, threshold)}`}>
              нетто {row.netSpreadPct != null ? `${row.netSpreadPct.toFixed(2)}%` : '—'}
            </span>
            {row.btcCorr != null && (
              <span className="text-[11px] text-zinc-500" title="Корреляция минутных доходностей с BTC за 60м">
                β(BTC) {row.btcCorr.toFixed(2)}
              </span>
            )}
            {row.fundingNextMin != null && (
              <span className="text-[11px] text-zinc-500" title={`Ближайший фандинг через ${row.fundingNextMin} мин (${row.fundingNextFrom})`}>
                фандинг через {row.fundingNextMin >= 60 ? `${Math.floor(row.fundingNextMin / 60)}ч ${row.fundingNextMin % 60}м` : `${row.fundingNextMin}м`}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <AiComment symbol={row.symbol} />

        {/* чарт спреда */}
        <section>
          <div className="mb-1 text-xs text-zinc-500">Динамика межбиржевого спреда (пунктир — ваш порог {threshold}%)</div>
          <SpreadChart points={hist} threshold={threshold} />
        </section>

        {/* по биржам */}
        <section>
          <div className="mb-1 text-xs text-zinc-500">
            Цены по биржам{row.fundingSpreadPct != null ? ` · разброс фандинга ${row.fundingSpreadPct.toFixed(3)}%` : ''}
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-600">
                <th className="py-1 text-left font-normal">Биржа</th>
                <th className="py-1 text-right font-normal">Цена</th>
                <th className="py-1 text-right font-normal">Откл. от эталона</th>
                <th className="py-1 text-right font-normal">Спот</th>
                <th className="py-1 text-right font-normal">Фандинг</th>
                <th className="py-1 text-right font-normal">OI</th>
              </tr>
            </thead>
            <tbody>
              {row.exchanges
                .slice()
                .sort((a, b) => a.price - b.price)
                .map((x) => {
                  const e = EX_MAP[x.exchange];
                  const dev = row.price > 0 ? ((x.price - row.price) / row.price) * 100 : 0;
                  const spotBasisEx = row.spotBasis?.ex === x.exchange ? row.spotBasis : null;
                  return (
                    <tr key={x.exchange} className="border-t border-zinc-900">
                      <td className="py-1" style={{ color: e.color }}>
                        {e.name}
                      </td>
                      <td className="py-1 text-right font-mono tabular-nums">{fmtPrice(x.price)}</td>
                      <td className={`py-1 text-right font-mono tabular-nums ${dev < -0.1 ? 'text-emerald-400' : dev > 0.1 ? 'text-rose-400' : 'text-zinc-400'}`}>
                        {dev >= 0 ? '+' : ''}
                        {dev.toFixed(3)}%
                      </td>
                      <td className={`py-1 text-right font-mono tabular-nums ${spotBasisEx && Math.abs(spotBasisEx.pct) >= 0.3 ? 'text-amber-400' : 'text-zinc-600'}`}>
                        {spotBasisEx ? `${spotBasisEx.pct >= 0 ? '+' : ''}${spotBasisEx.pct.toFixed(2)}%` : '—'}
                      </td>
                      <td className="py-1 text-right font-mono tabular-nums text-zinc-400">{fmtFunding(x.fundingRate)}</td>
                      <td className="py-1 text-right font-mono tabular-nums text-zinc-400">{fmtTurnover(x.oiUsd)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </section>

        <PositionCalc row={row} />
        <PaperSection row={row} />

        {/* сети + чарты */}
        <section className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs text-zinc-500">Сети вывода (OKX/Bitget)</div>
            <div className="flex flex-wrap gap-1">
              {nets == null ? (
                <span className="text-xs text-zinc-600">загрузка…</span>
              ) : nets.networks.length ? (
                nets.networks.map((n) => (
                  <span
                    key={`${n.source}-${n.chain}`}
                    title={`${n.chain} · вывод: ${n.withdrawEnabled ? 'да' : 'нет'} · депозит: ${n.depositEnabled ? 'да' : 'нет'}`}
                    className={`rounded border px-1.5 py-0.5 text-[11px] ${
                      n.withdrawEnabled && n.depositEnabled
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-500'
                    }`}
                  >
                    {n.network}
                  </span>
                ))
              ) : (
                <span className="text-xs text-zinc-600">{nets.note || 'нет данных'}</span>
              )}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
              Совпадающие сети у обеих бирж = возможен реальный перенос позиции. Если общих сетей нет — спред
              торгуем только парным лонг/шорт без вывода.
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs text-zinc-500">Цена 60м</div>
            <Sparkline data={row.spark} w={260} h={70} />
          </div>
        </section>

        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-zinc-500">
            скор {row.score} · покрытие {row.coverage}/6 · z {row.zScore != null ? row.zScore.toFixed(1) : '—'} · возраст{' '}
            {row.spreadAgeMin != null ? `${row.spreadAgeMin}м` : '—'} · оборот {fmtTurnover(row.turnoverUsd)}
            {row.rep?.winRate != null ? ` · репутация ${Math.round(row.rep.winRate * 100)}% (${row.rep.n})` : ''}
          </div>
          <a
            href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(row.tradingViewSymbol)}`}
            target="_blank"
            rel="noreferrer"
          >
            <Button size="sm" variant="outline" className="border-zinc-800 text-xs">
              ↗ TradingView
            </Button>
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}

