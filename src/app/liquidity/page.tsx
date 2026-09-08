'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { CoinRow, ScanResponse } from '@/lib/screener/types';
import { EX_MAP } from '@/components/screener/format';
/* Пороги паттерна берутся из детектора, а не переписываются числом в подписи:
   разошедшаяся подпись объясняет правило, которого нет. */
import { ROBOT_ALGO_MIN, ROBOT_ILLIQ_MIN, TAPE_MIN_TRADES } from '@/lib/screener/liquidity';
import { MM_DEFAULT_QUOTE_USD } from '@/lib/screener/mm';

/* Раздел «Неликвид»: детектор входа робота в неликвидные монеты.
   Паттерн = механические клипы + регулярные интервалы + тейкер-агрессия
   на тонком стакане при разошедшемся межбиржевом спреде. */

interface LiqFilters {
  search: string;
  minAlgo: number;
  minIlliq: number;
  onlyPattern: boolean;
  sortKey: string;
  sortDir: 'asc' | 'desc';
}

const DEFAULT_LIQ: LiqFilters = { search: '', minAlgo: 0, minIlliq: 0, onlyPattern: false, sortKey: 'algo', sortDir: 'desc' };

function loadLs(): LiqFilters {
  if (typeof window === 'undefined') return DEFAULT_LIQ;
  try {
    const raw = window.localStorage.getItem('ms_liq_filters');
    return raw ? { ...DEFAULT_LIQ, ...(JSON.parse(raw) as LiqFilters) } : DEFAULT_LIQ;
  } catch {
    return DEFAULT_LIQ;
  }
}

function beepLow() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'triangle';
    osc.frequency.value = 620;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    setTimeout(() => void ctx.close(), 700);
  } catch {
    /* autoplay policy */
  }
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—';
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return v.toFixed(0);
}

function algoColor(v: number): string {
  if (v >= 70) return 'text-rose-400';
  if (v >= 55) return 'text-amber-400';
  if (v >= 35) return 'text-zinc-300';
  return 'text-zinc-500';
}

function illiqColor(v: number): string {
  if (v >= 70) return 'text-rose-400';
  if (v >= 50) return 'text-amber-400';
  if (v >= 30) return 'text-zinc-300';
  return 'text-zinc-500';
}

function AlgoBar({ v, proxy }: { v: number; proxy?: boolean }) {
  return (
    <div className="flex items-center gap-1.5" title={proxy ? 'Прокси без ленты сделок' : 'Точный скор: клипы+интервалы+агрессия+OI/объём'}>
      <div className="h-1.5 w-10 overflow-hidden rounded bg-zinc-800">
        <div className={`h-full ${v >= 55 ? 'bg-amber-400' : 'bg-zinc-600'}`} style={{ width: `${Math.min(100, v)}%` }} />
      </div>
      <span className={`w-7 font-mono text-xs tabular-nums ${algoColor(v)} ${proxy ? 'opacity-60' : ''}`}>
        {v}
        {proxy ? '*' : ''}
      </span>
    </div>
  );
}

function getVal(r: CoinRow, key: string): number | string | null {
  const d = r.deep;
  switch (key) {
    case 'symbol':
      return r.symbol;
    case 'algo':
      return d?.algoScore ?? r.algoProxy ?? 0;
    case 'illiq':
      return d?.illiqScore ?? r.illiqProxy ?? 0;
    case 'net':
      return r.netSpreadPct ?? r.crossSpreadPct;
    case 'slip':
      return d?.slip25kPct ?? null;
    case 'maxpos':
      return d?.maxPosUsd ?? null;
    case 'mm':
      return d?.mm?.score ?? null;
    case 'depth':
      if (!d) return null;
      return Math.min(...Object.values(d.perEx).map((x) => x.depth25Usd));
    case 'aggr':
      return d?.tape?.aggression ?? null;
    case 'clip':
      return d?.tape?.clipRatio ?? null;
    case 'big':
      return d?.tape?.bigNetUsd ?? null;
    case 'turnover':
      return r.turnoverUsd;
    default:
      return r.score;
  }
}

export default function LiquidityPage() {
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [filters, setFilters] = useState<LiqFilters>(loadLs);
  const [sound, setSound] = useState(true);
  const [updated, setUpdated] = useState<number>(0);
  const [robotWr, setRobotWr] = useState<{ wr: number | null; n: number } | null>(null);
  const seenPatterns = useRef<Set<string>>(new Set());
  const soundRef = useRef(sound);
  soundRef.current = sound;

  const setF = useCallback((f: Partial<LiqFilters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...f };
      try {
        window.localStorage.setItem('ms_liq_filters', JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        /* Раздел «Неликвид» сканирует полосу неликвида, а не топ по обороту: на общем
           универсуме сюда попадали 80 самых ликвидных монет рынка, и «неликвид 80»
           означал лишь «наименее ликвидная из очень ликвидных». */
        const res = await fetch('/api/scan?top=80&universe=illiquid', { cache: 'no-store' });
        if (!res.ok) return;
        const j = (await res.json()) as ScanResponse;
        if (!alive) return;
        setScan(j);
        setUpdated(Date.now());
        for (const r of j.rows) {
          if (r.deep?.pattern?.robotIlliquid && !seenPatterns.current.has(r.symbol)) {
            seenPatterns.current.add(r.symbol);
            if (soundRef.current) beepLow();
          }
        }
        // win-rate паттерна «робот» из истории
        try {
          const pr = await fetch('/api/patterns', { cache: 'no-store' });
          if (pr.ok && alive) {
            const pj = (await pr.json()) as { stats: Array<{ pattern: string; winRate: number | null; wins: number; losses: number }> };
            const rs = pj.stats.find((x) => x.pattern === 'robot');
            if (rs) setRobotWr({ wr: rs.winRate, n: rs.wins + rs.losses });
          }
        } catch {
          /* статистика не критична */
        }
      } catch {
        /* сеть моргнула */
      }
    };
    void load();
    const iv = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, 45_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const rows = scan?.rows ?? [];

  const patterns = useMemo(
    () => rows.filter((r) => r.deep?.pattern?.robotIlliquid).sort((a, b) => (b.deep?.algoScore ?? 0) - (a.deep?.algoScore ?? 0)),
    [rows]
  );

  const table = useMemo(() => {
    const q = filters.search.trim().toUpperCase();
    const out = rows.filter((r) => {
      if (q && !r.symbol.includes(q)) return false;
      const algo = r.deep?.algoScore ?? r.algoProxy ?? 0;
      const illiq = r.deep?.illiqScore ?? r.illiqProxy ?? 0;
      if (algo < filters.minAlgo) return false;
      if (illiq < filters.minIlliq) return false;
      if (filters.onlyPattern && !r.deep?.pattern?.robotIlliquid) return false;
      return true;
    });
    const dir = filters.sortDir === 'asc' ? 1 : -1;
    return out.sort((a, b) => {
      const va = getVal(a, filters.sortKey);
      const vb = getVal(b, filters.sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * dir;
      return ((va as number) - (vb as number)) * dir;
    });
  }, [rows, filters]);

  const th = (key: string, label: string, cls = '') => (
    <th
      onClick={() => setF({ sortKey: key, sortDir: filters.sortKey === key && filters.sortDir === 'desc' ? 'asc' : 'desc' })}
      className={`cursor-pointer select-none px-2 py-2 text-left font-medium hover:text-zinc-200 ${filters.sortKey === key ? 'text-emerald-400' : ''} ${cls}`}
    >
      {label}
    </th>
  );

  const ageStr = updated ? Math.max(0, Math.round((Date.now() - updated) / 1000)) : null;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-200">
      {/* шапка */}
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3">
          <Link href="/" className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100">
            ← скринер
          </Link>
          <h1 className="text-xl font-bold tracking-tight">
            Неликвид<span className="text-amber-400"> · алго-детектор</span>
          </h1>
          <input
            value={filters.search}
            onChange={(e) => setF({ search: e.target.value })}
            placeholder="Поиск монеты…"
            className="h-8 w-32 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-sm"
          />
          <label className="flex items-center gap-1.5 text-sm text-zinc-400">
            алго ≥
            <input
              type="number"
              min="0"
              max="100"
              value={filters.minAlgo}
              onChange={(e) => setF({ minAlgo: parseInt(e.target.value) || 0 })}
              className="h-8 w-14 rounded-md border border-zinc-800 bg-zinc-900 px-2 font-mono text-sm tabular-nums"
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-zinc-400">
            неликвид ≥
            <input
              type="number"
              min="0"
              max="100"
              value={filters.minIlliq}
              onChange={(e) => setF({ minIlliq: parseInt(e.target.value) || 0 })}
              className="h-8 w-14 rounded-md border border-zinc-800 bg-zinc-900 px-2 font-mono text-sm tabular-nums"
            />
          </label>
          <button
            onClick={() => setF({ onlyPattern: !filters.onlyPattern })}
            className={`rounded-md border px-3 py-1.5 text-sm ${filters.onlyPattern ? 'border-rose-500/50 text-rose-400' : 'border-zinc-800 text-zinc-500'}`}
          >
            🤖 только паттерн
          </button>
          <button
            onClick={() => setSound(!sound)}
            className={`rounded-md border px-3 py-1.5 text-sm ${sound ? 'border-emerald-500/40 text-emerald-400' : 'border-zinc-800 text-zinc-500'}`}
          >
            {sound ? '🔔 звук вкл' : '🔕 звук выкл'}
          </button>
          <span className="ml-auto text-xs text-zinc-600">
            {ageStr != null ? `обновлено ${ageStr}s назад` : 'загрузка…'} · стакан+лента считаются для топ-40 по скору · * = прокси без ленты
          </span>
        </div>
      </div>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-4">
        {/* паттерн-карточки */}
        <section aria-label="Сработавший паттерн">
          <h2 className="mb-2 flex flex-wrap items-center gap-2 text-xs uppercase tracking-wider text-zinc-500">
            🤖 Паттерн «робот вошёл в неликвид» — {patterns.length ? patterns.length : 'нет сработавших'}
            {robotWr && robotWr.n > 0 && (
              <span
                className={`rounded border px-1.5 py-0.5 font-medium normal-case ${
                  robotWr.wr != null && robotWr.wr >= 0.6
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : robotWr.wr != null && robotWr.wr >= 0.4
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                      : 'border-rose-500/30 bg-rose-500/10 text-rose-400'
                }`}
                title="Сколько сигналов «робот вошёл» дали ход ≥ +0.5% за 30 минут — см. вкладку «История» на главной"
              >
                история: {Math.round((robotWr.wr ?? 0) * 100)}% в плюс · {robotWr.n} решённых
              </span>
            )}
          </h2>
          {patterns.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {patterns.map((r) => {
                const d = r.deep!;
                return (
                  <div key={r.symbol} className="rounded-xl border border-rose-500/40 bg-rose-500/5 p-4">
                    <div className="flex items-baseline justify-between">
                      <span className="text-lg font-bold text-zinc-50">{r.symbol.replace(/USDT$/, '')}</span>
                      <span className="font-mono text-xl font-bold tabular-nums text-rose-400">
                        {r.netSpreadPct != null && r.netSpreadPct > 0 ? `+${r.netSpreadPct.toFixed(2)}%` : `${(r.crossSpreadPct ?? 0).toFixed(2)}%`}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-4 text-xs text-zinc-400">
                      <span>
                        алго <b className={`tabular-nums ${algoColor(d.algoScore)}`}>{d.algoScore}</b>
                      </span>
                      <span>
                        неликвид <b className={`tabular-nums ${illiqColor(d.illiqScore)}`}>{d.illiqScore}</b>
                      </span>
                      <span>
                        max поз <b className="tabular-nums text-zinc-200">${fmtUsd(d.maxPosUsd)}</b>
                      </span>
                      {d.slip25kPct != null && (
                        <span>
                          слип $25k <b className="tabular-nums text-zinc-200">{d.slip25kPct.toFixed(2)}%</b>
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {d.pattern!.reasons.map((x, i) => (
                        <span key={i} className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-300">
                          {x}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 text-[11px] text-zinc-500">
                      {d.entryEx && d.exitEx && d.entryEx !== d.exitEx
                        ? `вход ${EX_MAP[d.entryEx].name} → выход ${EX_MAP[d.exitEx].name}`
                        : d.entryEx
                          ? `вход/выход ${EX_MAP[d.entryEx].name}`
                          : '—'}
                      {d.tape ? ` · лента ${d.tape.trades} сделок / ${Math.round(d.tape.windowSec / 60)}м` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-600">
              Паттернов сейчас нет: роботы не давят неликвид. Таблица ниже показывает алго-активность и неликвидность
              всех монет — паттерн сработает, когда совпадёт всё (алго ≥{ROBOT_ALGO_MIN} · неликвид ≥{ROBOT_ILLIQ_MIN} ·
              лента ≥{TAPE_MIN_TRADES} сделок в часовом окне).
            </div>
          )}
        </section>

        {/* таблица */}
        <section className="mt-6" aria-label="Таблица неликвидности">
          <h2 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">
            Алго-активность и глубина стакана — {table.length} монет
          </h2>
          {!table.length ? (
            <div className="py-10 text-center text-sm text-zinc-600">Нет монет под фильтры</div>
          ) : (
            <>
              {/* desktop */}
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-zinc-800 text-[11px] uppercase tracking-wide text-zinc-500">
                      {th('symbol', 'Монета')}
                      {th('algo', 'Алго', 'w-24')}
                      {th('illiq', 'Неликвид')}
                      {th('net', 'Нетто, %')}
                      {th('slip', 'Слип $10k')}
                      {th('slip', 'Слип $25k')}
                      {th('slip', 'Слип $50k')}
                      {th('mm', 'ММ')}
                      {th('maxpos', 'Max позиция')}
                      {th('depth', 'Глубина ±0.25%')}
                      {th('aggr', 'Агрессия')}
                      {th('clip', 'Клипы')}
                      {th('big', 'Киты >$100k')}
                      {th('turnover', 'Оборот 24ч')}
                      <th className="px-2 py-2 text-left font-medium">Вход → Выход</th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.map((r) => {
                      const d = r.deep;
                      const entry = d?.entryEx ?? r.bestAsk?.exchange;
                      const exit = d?.exitEx ?? r.bestBid?.exchange;
                      const minDepth = d ? Math.min(...Object.values(d.perEx).map((x) => x.depth25Usd)) : null;
                      return (
                        <tr key={r.symbol} className="border-b border-zinc-900/70 hover:bg-zinc-900/50">
                          <td className="px-2 py-1.5">
                            <span className="font-semibold text-zinc-100">{r.symbol.replace(/USDT$/, '')}</span>
                            {d?.pattern?.robotIlliquid && (
                              <span className="ml-1.5 rounded bg-rose-500/15 px-1 text-[10px] font-semibold text-rose-400">ROBOT</span>
                            )}
                            {r.sweepFresh && r.sweepFresh.ageMin <= 15 && (
                              <span className="ml-1.5 rounded bg-fuchsia-500/15 px-1 text-[10px] font-semibold text-fuchsia-400">SWEEP</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <AlgoBar v={d?.algoScore ?? r.algoProxy ?? 0} proxy={!d} />
                          </td>
                          <td className={`px-2 py-1.5 font-mono text-xs tabular-nums ${illiqColor(d?.illiqScore ?? r.illiqProxy ?? 0)} ${!d ? 'opacity-60' : ''}`}>
                            {d?.illiqScore ?? r.illiqProxy ?? '—'}
                            {!d ? '*' : ''}
                          </td>
                          <td className={`px-2 py-1.5 font-mono tabular-nums ${(r.netSpreadPct ?? 0) >= 0.3 ? 'text-emerald-400' : 'text-zinc-300'}`}>
                            {r.netSpreadPct != null ? r.netSpreadPct.toFixed(2) : '—'}
                          </td>
                          {[10_000, 25_000, 50_000].map((usd) => {
                            const w = (d?.entryEx && d.perEx[d.entryEx]) || (d ? Object.values(d.perEx)[0] : undefined);
                            const v = w ? (usd === 10_000 ? w.slip10kPct : usd === 25_000 ? w.slip25kPct : w.slip50kPct) : null;
                            return (
                              <td key={usd} className={`px-2 py-1.5 font-mono tabular-nums ${v != null && v >= 0.3 ? 'text-rose-400' : 'text-zinc-300'}`}>
                                {v != null ? `${v.toFixed(2)}%` : '—'}
                              </td>
                            );
                          })}
                          {/* Маркет-мейкинг: спред своей книги минус две мейкерские комиссии. Ключевая
                              величина — не доход, а volRatio: забираемый за круг спред против движения
                              цены за это же время. Ниже 1 котировку сносит шумом раньше, чем она
                              заработает, поэтому такие строки не подсвечиваются как возможность. */}
                          <td
                            className="px-2 py-1.5 font-mono tabular-nums"
                            title={
                              d?.mm
                                ? `${d.mm.ex}: спред ${d.mm.spreadBps} б.п. → ${d.mm.spreadNetBps} б.п. после двух мейкерских комиссий\n` +
                                  `котировка $${d.mm.quoteSizeUsd} на сторону · ${d.mm.roundTripsPerHour} кругов/ч · держим ${d.mm.holdMin ?? '—'} мин\n` +
                                  `спред за круг / ход цены за это время = ${d.mm.volRatio ?? '—'} (нужно >1)\n` +
                                  `валовая оценка $${d.mm.grossUsdPerHour}/ч — без адверс-селекшена и приоритета в очереди`
                                : 'нет стакана и ленты на одной бирже'
                            }
                          >
                            {d?.mm ? (
                              <span className={d.mm.viable ? 'text-emerald-400' : d.mm.spreadNetBps <= 0 ? 'text-zinc-600' : 'text-zinc-400'}>
                                {d.mm.viable ? `$${d.mm.grossUsdPerHour}/ч` : d.mm.spreadNetBps <= 0 ? 'нет спреда' : `×${d.mm.volRatio ?? '—'}`}
                              </span>
                            ) : (
                              <span className="text-zinc-700">—</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 font-mono tabular-nums text-zinc-200">${fmtUsd(d?.maxPosUsd ?? null)}</td>
                          <td className={`px-2 py-1.5 font-mono tabular-nums ${minDepth != null && minDepth < 100_000 ? 'text-amber-400' : 'text-zinc-300'}`}>
                            ${fmtUsd(minDepth)}
                          </td>
                          <td className={`px-2 py-1.5 font-mono tabular-nums ${d?.tape && Math.abs(d.tape.aggression) >= 0.3 ? (d.tape.aggression > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-400'}`}>
                            {d?.tape ? `${d.tape.aggression > 0 ? '+' : ''}${d.tape.aggression.toFixed(2)}` : '—'}
                          </td>
                          <td className="px-2 py-1.5 font-mono tabular-nums text-zinc-400">
                            {d?.tape && d.tape.clipCount >= 5 ? `${Math.round(d.tape.clipRatio * 100)}% ×${d.tape.clipCount}` : '—'}
                          </td>
                          <td className={`px-2 py-1.5 font-mono tabular-nums ${d?.tape && Math.abs(d.tape.bigNetUsd) >= 100_000 ? (d.tape.bigNetUsd > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-500'}`}>
                            {d?.tape && Math.abs(d.tape.bigNetUsd) >= 10_000 ? `${d.tape.bigNetUsd > 0 ? '+' : ''}${fmtUsd(d.tape.bigNetUsd)}` : '—'}
                          </td>
                          <td className="px-2 py-1.5 font-mono tabular-nums text-zinc-400">${fmtUsd(r.turnoverUsd)}</td>
                          <td className="px-2 py-1.5 text-[11px]">
                            {entry && exit && entry !== exit ? (
                              <>
                                <span style={{ color: EX_MAP[entry].color }}>{EX_MAP[entry].name}</span>
                                <span className="text-zinc-600"> → </span>
                                <span style={{ color: EX_MAP[exit].color }}>{EX_MAP[exit].name}</span>
                              </>
                            ) : entry ? (
                              <span style={{ color: EX_MAP[entry].color }}>{EX_MAP[entry].name}</span>
                            ) : (
                              <span className="text-zinc-700">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* mobile */}
              <div className="space-y-2 lg:hidden">
                {table.map((r) => {
                  const d = r.deep;
                  const minDepth = d ? Math.min(...Object.values(d.perEx).map((x) => x.depth25Usd)) : null;
                  return (
                    <div key={r.symbol} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-zinc-100">{r.symbol.replace(/USDT$/, '')}</span>
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`font-mono tabular-nums ${algoColor(d?.algoScore ?? r.algoProxy ?? 0)}`}>
                            алго {d?.algoScore ?? r.algoProxy ?? '—'}
                            {!d ? '*' : ''}
                          </span>
                          <span className={`font-mono tabular-nums ${illiqColor(d?.illiqScore ?? r.illiqProxy ?? 0)}`}>
                            неликв {d?.illiqScore ?? r.illiqProxy ?? '—'}
                          </span>
                        </div>
                      </div>
                      <div className="mt-1.5 grid grid-cols-3 gap-2 text-center text-xs">
                        <div>
                          <div className="text-[10px] text-zinc-600">нетто</div>
                          <div className="font-mono tabular-nums text-zinc-300">{r.netSpreadPct != null ? `${r.netSpreadPct.toFixed(2)}%` : '—'}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-zinc-600">слип $25k</div>
                          <div className="font-mono tabular-nums text-zinc-300">{d?.slip25kPct != null ? `${d.slip25kPct.toFixed(2)}%` : '—'}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-zinc-600">max поз</div>
                          <div className="font-mono tabular-nums text-zinc-300">${fmtUsd(d?.maxPosUsd ?? null)}</div>
                        </div>
                      </div>
                      <div className="mt-1.5 text-[10px] text-zinc-500">
                        {minDepth != null ? `глубина ±0.25%: $${fmtUsd(minDepth)}` : 'стакан не замерялся'}
                        {d?.tape ? ` · агрессия ${d.tape.aggression > 0 ? '+' : ''}${d.tape.aggression.toFixed(2)}` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {/* легенда */}
        <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-xs leading-relaxed text-zinc-500">
          <b className="text-zinc-300">Как читать:</b> «Алго» — вероятность, что монету двигает робот: кластеры сделок
          одного размера (клипы), механически регулярные интервалы между ними, перекос тейкер-агрессии, подтверждённые
          всплеском ΔOI/объёма. «Неликвид» — насколько тонкий рынок: глубина стакана в ±0.25%, проскальзывание рыночных
          ордеров $10k/$25k/$50k, коэффициент Амихуда (% движения на $1M) и оборот. «Max позиция» — крупнейший ордер с
          слипейджем ≤0.3% на худшей из бирж входа/выхода — больше этой суммы входить опасно, сами разгоните спред.
          Колонка «ММ» — пассивный маркет-мейкинг: спред собственной книги минус две мейкерские комиссии, на бирже, где
          есть и стакан, и лента. Зелёное число — валовая оценка $/час при котировке ${MM_DEFAULT_QUOTE_USD} на сторону
          (ограничена max-позицией). «×N» — не возможность, а причина отказа: за круг забирается в N раз меньше, чем
          цена успевает пройти за это же время, и котировку сносит шумом раньше, чем она заработает; нужно больше 1.
          «Нет спреда» — спред книги уже́ двух мейкерских комиссий, пассивно заработать нельзя в принципе. Оценка
          валовая: без адверс-селекшена и без приоритета в очереди, то есть это потолок, а не ожидание.
          <br />
          <br />
          Паттерн «робот вошёл» = алго ≥{ROBOT_ALGO_MIN} + неликвид ≥{ROBOT_ILLIQ_MIN} при ленте не реже{' '}
          {TAPE_MIN_TRADES} сделок в часовом окне: кто-то работает в тонкой книге механически. Межбиржевого разрыва в
          условии больше нет — на замере полосы неликвида спред и алго-активность не совпадали ни разу, это разные
          явления; разрыв, если он есть, остаётся в списке причин. Зарабатывает ли паттерн — показывает не порог, а
          доверительный интервал матожидания во вкладке «История паттернов».
        </section>
      </main>

      <footer className="mt-auto border-t border-zinc-800 px-4 py-3 text-[10px] text-zinc-600">
        Стакан: Bybit · BingX · OKX · Bitget (L2-снапшоты, кэш 180с). Лента сделок: биржа входа (тейкер-агрессия,
        кэш 120с). Детекция роботов вероятностная — возможны ложные срабатывания на аукционных всплесках.
      </footer>
    </div>
  );
}

