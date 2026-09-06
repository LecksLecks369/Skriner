'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ExchangeId } from '@/lib/screener/types';

type PatternKind = 'spread' | 'robot' | 'sweep' | 'whale' | 'funding';

interface PatternStat {
  pattern: PatternKind;
  icon: string;
  name: string;
  hint: string;
  total: number;
  n24h: number;
  resolved: number;
  wins: number;
  losses: number;
  expired: number;
  waiting: number;
  winRate: number | null;
  avgMfeWin: number | null;
  avgMfeLoss: number | null;
  lastTs: number | null;
}

interface PatternSig {
  key: string;
  ts: number;
  symbol: string;
  pattern: PatternKind;
  dir: 'long' | 'short' | 'arb';
  price: number;
  ex: ExchangeId | null;
  netPct?: number | null;
  zScore?: number | null;
  score?: number;
  algoScore?: number;
  illiqScore?: number;
  aggression?: number;
  whaleUsd?: number;
  fundingPct?: number;
  wickAtr?: number;
  volMult?: number;
  outcome?: {
    mfePct: number | null;
    maePct: number | null;
    movePct: number | null;
    win: boolean | null;
    expired?: boolean;
  };
}

interface Resp {
  stats: PatternStat[];
  anyWaiting: number;
  signals: PatternSig[];
}

const KIND_LABEL: Record<PatternKind, { icon: string; name: string; color: string }> = {
  spread: { icon: '🔀', name: 'Спред', color: 'text-sky-400 border-sky-500/30 bg-sky-500/10' },
  robot: { icon: '🤖', name: 'Робот', color: 'text-violet-400 border-violet-500/30 bg-violet-500/10' },
  sweep: { icon: '🌊', name: 'Свип', color: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  whale: { icon: '🐋', name: 'Киты', color: 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10' },
  funding: { icon: '💸', name: 'Фандинг', color: 'text-fuchsia-400 border-fuchsia-500/30 bg-fuchsia-500/10' },
};

function metricOf(s: PatternSig): string {
  switch (s.pattern) {
    case 'spread':
      return `нетто +${(s.netPct ?? 0).toFixed(2)}%`;
    case 'robot':
      return `алго ${s.algoScore ?? '—'} · неликв ${s.illiqScore ?? '—'}`;
    case 'sweep':
      return `тень ${s.wickAtr ?? '—'}×ATR · объём ×${s.volMult ?? '—'}`;
    case 'whale': {
      const v = s.whaleUsd ?? 0;
      const sign = v > 0 ? '+' : '−';
      return `киты ${sign}$${Math.abs(v) >= 1000 ? Math.round(Math.abs(v) / 1000) + 'K' : Math.round(Math.abs(v))}`;
    }
    case 'funding':
      return `фандинг ${(s.fundingPct ?? 0) > 0 ? '+' : ''}${(s.fundingPct ?? 0).toFixed(3)}%`;
  }
}

function DirBadge({ dir }: { dir: 'long' | 'short' | 'arb' }) {
  if (dir === 'arb') return <span className="text-zinc-500">⇄ arb</span>;
  if (dir === 'long') return <span className="text-emerald-400">▲ лонг</span>;
  return <span className="text-rose-400">▼ шорт</span>;
}

function winRateColor(wr: number | null): string {
  if (wr == null) return 'text-zinc-500';
  if (wr >= 0.6) return 'text-emerald-400';
  if (wr >= 0.4) return 'text-amber-400';
  return 'text-rose-400';
}

export function PatternHistory() {
  const [data, setData] = useState<Resp | null>(null);
  const [kind, setKind] = useState<PatternKind | 'all'>('all');

  useEffect(() => {
    const load = () =>
      void fetch('/api/patterns', { cache: 'no-store' })
        .then((r) => r.json())
        .then(setData)
        .catch(() => undefined);
    load();
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, []);

  const signals = useMemo(() => {
    const arr = data?.signals || [];
    return kind === 'all' ? arr : arr.filter((s) => s.pattern === kind);
  }, [data, kind]);

  return (
    <div className="space-y-4 p-3 sm:p-5">
      {/* Карточки паттернов */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {(data?.stats || []).map((st) => {
          const k = KIND_LABEL[st.pattern];
          return (
            <div key={st.pattern} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
              <div className="flex items-center justify-between">
                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${k.color}`}>
                  {k.icon} {st.name}
                </span>
                <span className="text-[10px] text-zinc-600">24ч: {st.n24h}</span>
              </div>
              <div className={`mt-2 font-mono text-2xl tabular-nums ${winRateColor(st.winRate)}`}>
                {st.winRate != null ? `${Math.round(st.winRate * 100)}%` : '—'}
              </div>
              <div className="text-[10px] text-zinc-600">
                в плюс из решённых: {st.wins} из {st.wins + st.losses}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-2 text-[10px] text-zinc-500">
                <span>всего: {st.total}</span>
                {st.waiting > 0 && <span className="text-zinc-400">ждут: {st.waiting}</span>}
                {st.expired > 0 && <span>истекло: {st.expired}</span>}
              </div>
              {(st.avgMfeWin != null || st.avgMfeLoss != null) && (
                <div className="mt-1 flex gap-2 text-[10px] tabular-nums">
                  {st.avgMfeWin != null && <span className="text-emerald-500/80">макс. ход в плюс: +{st.avgMfeWin.toFixed(2)}%</span>}
                  {st.avgMfeLoss != null && <span className="text-rose-500/70">у мимо: +{st.avgMfeLoss.toFixed(2)}%</span>}
                </div>
              )}
              <div className="mt-1.5 border-t border-zinc-800/80 pt-1.5 text-[10px] leading-snug text-zinc-600">{st.hint}</div>
            </div>
          );
        })}
      </div>

      <p className="max-w-3xl text-[11px] leading-relaxed text-zinc-600">
        Каждый тип сигнала оценивается автоматически через 30 минут после срабатывания: направленные паттерны
        (робот, свип, киты, фандинг) — по максимальному ходу цены в сторону сигнала; спред — по схлопыванию
        разрыва вдвое. Оценка живёт на сервере и переживает перезапуск: серии в памяти до ~9 часов, затем
        докупаются минутные клайны биржи сигнала. Сигналы старше 6 часов без данных помечаются «истёк» и в
        win-rate не попадают. Статистика честно копится с нуля — чем дольше работает скринер, тем надёжнее цифры.
      </p>

      {/* Фильтр по типу */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setKind('all')}
          className={`rounded-md border px-2.5 py-1 text-xs transition ${
            kind === 'all' ? 'border-zinc-500 bg-zinc-800 text-zinc-100' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
          }`}
        >
          все
        </button>
        {(Object.keys(KIND_LABEL) as PatternKind[]).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded-md border px-2.5 py-1 text-xs transition ${
              kind === k ? KIND_LABEL[k].color : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {KIND_LABEL[k].icon} {KIND_LABEL[k].name}
          </button>
        ))}
      </div>

      {/* Таблица сигналов */}
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full min-w-[760px] text-xs">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-[10px] uppercase text-zinc-600">
              <th className="px-3 py-2 font-medium">время</th>
              <th className="px-3 py-2 font-medium">паттерн</th>
              <th className="px-3 py-2 font-medium">монета</th>
              <th className="px-3 py-2 font-medium">направление</th>
              <th className="px-3 py-2 text-right font-medium">цена входа</th>
              <th className="px-3 py-2 font-medium">метрика</th>
              <th className="px-3 py-2 text-right font-medium">исход (30м)</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s) => {
              const k = KIND_LABEL[s.pattern];
              const oc = s.outcome;
              return (
                <tr key={s.key} className="border-b border-zinc-900/70">
                  <td className="px-3 py-1.5 tabular-nums text-zinc-500">
                    {new Date(s.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] ${k.color}`}>
                      {k.icon} {k.name}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 font-semibold text-zinc-200">{s.symbol.replace(/USDT$/, '')}</td>
                  <td className="px-3 py-1.5">
                    <DirBadge dir={s.dir} />
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-zinc-400">{fmtPrice(s.price)}</td>
                  <td className="px-3 py-1.5 tabular-nums text-zinc-500">{metricOf(s)}</td>
                  <td className="px-3 py-1.5 text-right">
                    {!oc ? (
                      <span className="text-zinc-700">ждёт 30м…</span>
                    ) : oc.win === true ? (
                      <span className="font-medium text-emerald-400">
                        в плюс {s.pattern === 'spread' ? '' : '+'}
                        {oc.mfePct != null ? `${oc.mfePct.toFixed(2)}%` : ''}
                        {s.pattern === 'spread' && oc.movePct != null ? ` (−${Math.abs(oc.movePct).toFixed(2)} п.п.)` : ''}
                      </span>
                    ) : oc.win === false ? (
                      <span className="text-rose-400">
                        мимо{oc.mfePct != null ? ` · макс ход +${oc.mfePct.toFixed(2)}%` : ''}
                      </span>
                    ) : (
                      <span className="text-amber-500/80">истёк без данных</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!signals.length && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-zinc-700">
                  Пока пусто: сигналы появляются по мере работы скринера (спред ≥ 0.25%, робот в неликвиде,
                  свежий свип, киты ≥ $300K, фандинг ≥ 0.1%)
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.anyWaiting > 0 && (
        <p className="text-[11px] text-zinc-600">
          ⏳ Сигналов в очереди на оценку: {data.anyWaiting} — дооцениваются батчами до 10 за скан-цикл.
        </p>
      )}
    </div>
  );
}

function fmtPrice(p: number): string {
  if (!p) return '—';
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

