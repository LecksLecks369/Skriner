'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ExchangeId } from '@/lib/screener/types';

type PatternKind = 'spread' | 'robot' | 'sweep' | 'whale' | 'funding' | 'breakout' | 'distribution' | 'chop';

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
  expectancyPct: number | null; // чистое матожидание: после издержек круга
  expectancyGrossPct: number | null; // до издержек — разница показывает, сколько съедает круг
  avgCostPct: number | null;
  sumPnlPct: number | null;
  byExit: { tp: number; sl: number; timeout: number; converged: number };
  avgMaeWin: number | null;
  edge: EdgeReport;
  population: string;
  alertScope: 'same' | 'differs' | 'none';
  alertNote: string;
}

/* Отчёт по эджу: матожидание с доверительным интервалом и вердикт. Одно число без
   интервала на выборке в десяток сделок читается как факт, хотя фактом не является,
   поэтому в карточке показываются оба конца интервала и размер выборки. */
interface EdgeReport {
  n: number;
  nTotal: number;
  expectancyPct: number | null;
  ciLoPct: number | null;
  ciHiPct: number | null;
  winRate: number | null;
  winLoPct: number | null;
  winHiPct: number | null;
  profitFactor: number | null;
  sumPnlPct: number | null;
  verdict: 'insufficient' | 'negative' | 'inconclusive' | 'positive';
  muted: boolean;
  reason: string;
}

const VERDICT: Record<EdgeReport['verdict'], { label: string; cls: string }> = {
  insufficient: { label: 'мало данных', cls: 'text-zinc-500 border-zinc-700 bg-zinc-800/50' },
  negative: { label: 'выключен', cls: 'text-rose-400 border-rose-500/40 bg-rose-500/10' },
  inconclusive: { label: 'не доказан', cls: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  positive: { label: 'эдж есть', cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
};

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
  /* сетапы движения */
  setupScore?: number;
  level?: number;
  distAtr?: number;
  distKind?: string;
  movePct?: number;
  erThr?: number;
  bandPct?: number; // legacy: сигналы ерша до перехода на будущий ER
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
  breakout: { icon: '⚡', name: 'Пробой', color: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
  distribution: { icon: '📦', name: 'Раздача', color: 'text-rose-400 border-rose-500/30 bg-rose-500/10' },
  chop: { icon: '〰', name: 'Ёрш', color: 'text-orange-400 border-orange-500/30 bg-orange-500/10' },
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
    case 'breakout':
      return `готовность ${s.setupScore ?? '—'} · до уровня ${s.distAtr ?? '—'} ATR`;
    case 'distribution':
      return `${s.distKind === 'pump_distribution' ? 'раздача' : 'набор'} ${s.setupScore ?? '—'} · ход ${
        (s.movePct ?? 0) > 0 ? '+' : ''
      }${(s.movePct ?? 0).toFixed(2)}%`;
    case 'chop':
      return `ёрш ${s.setupScore ?? '—'} · порог эффективности ≤ ${s.erThr != null ? s.erThr.toFixed(3) : '—'}`;
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
            <div
              key={st.pattern}
              className={`rounded-lg border bg-zinc-900/50 p-3 ${st.edge?.muted ? 'border-rose-500/30 opacity-70' : 'border-zinc-800'}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${k.color}`}>
                  {k.icon} {st.name}
                </span>
                {(() => {
                  /* Паттерн-предупреждение («ёрш») сделку не предлагает, поэтому его исходы
                     не несут P&L и матожидание для него не считается никогда. Вердикт
                     «мало данных» здесь читался бы как «подожди ещё» — а ждать нечего:
                     исходы есть, просто мерить в процентах нечего. */
                  const noPnl = st.resolved > 0 && st.edge != null && st.edge.n === 0;
                  if (noPnl) {
                    return (
                      <span
                        className="rounded border border-zinc-700 bg-zinc-800/50 px-1.5 py-0.5 text-[10px] text-zinc-400"
                        title="Сигнал-предупреждение, а не сделка: матожидание не считается — измеряется только, сбылось ли предупреждение"
                      >
                        без P&L
                      </span>
                    );
                  }
                  return st.edge ? (
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] ${VERDICT[st.edge.verdict].cls}`} title={st.edge.reason}>
                      {VERDICT[st.edge.verdict].label}
                    </span>
                  ) : (
                    <span className="text-[10px] text-zinc-600">24ч: {st.n24h}</span>
                  );
                })()}
              </div>
              {/* Крупная цифра — win-rate ЗА ВСЮ историю, а вердикт рядом и блок эджа
                  ниже стоят на окне последних исходов. Это разные популяции, и пока обе
                  были подписаны одними словами «на сделку» / «%», карточка показывала
                  два win-rate и два матожидания, различающиеся на десяток пунктов,
                  как если бы это была одна величина. Подпись теперь называет окно. */}
              <div className={`mt-2 font-mono text-2xl tabular-nums ${winRateColor(st.winRate)}`}>
                {st.winRate != null ? `${Math.round(st.winRate * 100)}%` : '—'}
              </div>
              <div className="text-[10px] text-zinc-600">
                за всю историю: {st.wins} из {st.wins + st.losses} решённых
              </div>
              {/* Доля неоценённых — часть определения популяции, а не служебная
                  статистика: если исход чаще не вычисляется, чем вычисляется, цифра
                  выше описывает выборку, которую отобрала доступность данных. */}
              {st.total > 0 && (
                <div
                  className={`text-[10px] ${
                    st.expired > st.resolved ? 'text-amber-500/80' : 'text-zinc-600'
                  }`}
                  title="Истёкшие — сигналы, для которых исход посчитать было нечем: окно ушло за пределы доступной истории цен"
                >
                  {st.expired > st.resolved ? '⚠ ' : ''}
                  без исхода: {Math.round((st.expired / st.total) * 100)}% ({st.expired} из {st.total})
                </div>
              )}
              {/* Подпись популяции. Цифра выше описывает выборку, а не рынок, и без
                  условия отбора неинтерпретируема. Отдельной строкой — расхождение с
                  алертом: у спреда порог записи фиксирован, а порог алерта пользователь
                  задаёт сам, поэтому win-rate посчитан не по тем сигналам, которые до
                  него доехали, и молчать об этом нельзя. */}
              <div className="mt-1 text-[10px] leading-snug text-zinc-600">
                <span className="text-zinc-700">считается по: </span>
                {st.population}
              </div>
              {st.alertScope !== 'same' && (
                <div
                  className={`mt-0.5 text-[10px] leading-snug ${
                    st.alertScope === 'differs' ? 'text-amber-500/80' : 'text-zinc-700'
                  }`}
                >
                  {st.alertScope === 'differs' ? '⚠ ' : ''}
                  {st.alertNote}
                </div>
              )}
              {st.edge && st.edge.expectancyPct != null && (
                <div className="mt-1.5 rounded border border-zinc-800/80 bg-zinc-950/40 p-1.5 text-[10px] tabular-nums">
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="text-zinc-500" title="Окно последних исходов — та же выборка, на которой стоит вердикт и авто-отключение">
                      эдж на сделку (окно n={st.edge.n})
                    </span>
                    <span className={st.edge.expectancyPct > 0 ? 'font-medium text-emerald-400' : 'font-medium text-rose-400'}>
                      {st.edge.expectancyPct > 0 ? '+' : ''}
                      {st.edge.expectancyPct.toFixed(3)}%
                    </span>
                  </div>
                  {st.edge.ciLoPct != null && st.edge.ciHiPct != null && (
                    <div className="mt-0.5 flex items-baseline justify-between gap-1 text-zinc-600">
                      <span>95% интервал</span>
                      <span>
                        [{st.edge.ciLoPct > 0 ? '+' : ''}
                        {st.edge.ciLoPct.toFixed(3)}; {st.edge.ciHiPct > 0 ? '+' : ''}
                        {st.edge.ciHiPct.toFixed(3)}]
                      </span>
                    </div>
                  )}
                  <div className="mt-0.5 flex items-baseline justify-between gap-1 text-zinc-600">
                    <span>выборка</span>
                    <span>
                      n={st.edge.n}
                      {st.edge.nTotal > st.edge.n && ` из ${st.edge.nTotal}`}
                      {st.edge.profitFactor != null && ` · PF ${st.edge.profitFactor.toFixed(2)}`}
                    </span>
                  </div>
                  <div className="mt-1 leading-snug text-zinc-600">{st.edge.reason}</div>
                  {st.edge.muted && (
                    <div className="mt-1 leading-snug text-rose-400/90">
                      алерты этого типа выключены; сигналы продолжают писаться в историю — тип включится сам, когда убыточные исходы выйдут из окна
                    </div>
                  )}
                </div>
              )}
              <div className="mt-1.5 flex flex-wrap gap-x-2 text-[10px] text-zinc-500">
                <span>всего: {st.total}</span>
                <span>24ч: {st.n24h}</span>
                {st.waiting > 0 && <span className="text-zinc-400">ждут: {st.waiting}</span>}
                {st.expired > 0 && <span>истекло: {st.expired}</span>}
              </div>
              {st.expectancyPct != null && (
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[10px] tabular-nums">
                  <span className="text-zinc-500" title="За всю историю — НЕ та выборка, по которой вынесен вердикт выше">
                    на сделку за всю историю:
                  </span>
                  <span className={st.expectancyPct > 0 ? 'font-medium text-emerald-400' : 'font-medium text-rose-400'}>
                    {st.expectancyPct > 0 ? '+' : ''}
                    {st.expectancyPct.toFixed(3)}%
                  </span>
                  {st.avgCostPct != null && st.expectancyGrossPct != null && (
                    <span className="text-zinc-600" title="результат до вычета издержек и стоимость круга">
                      ({st.expectancyGrossPct > 0 ? '+' : ''}
                      {st.expectancyGrossPct.toFixed(3)}% − круг {st.avgCostPct.toFixed(3)}%)
                    </span>
                  )}
                  <span className="text-zinc-600">
                    тейк {st.byExit.tp} / стоп {st.byExit.sl}
                    {st.byExit.converged > 0 && <> / сошёлся {st.byExit.converged}</>} / время {st.byExit.timeout}
                  </span>
                </div>
              )}
              {(st.avgMfeWin != null || st.avgMaeWin != null) && (
                <div className="mt-1 flex gap-2 text-[10px] tabular-nums">
                  {st.avgMfeWin != null && <span className="text-emerald-500/80">ход в плюс: +{st.avgMfeWin.toFixed(2)}%</span>}
                  {st.avgMaeWin != null && <span className="text-zinc-500">пересидели: −{st.avgMaeWin.toFixed(2)}%</span>}
                </div>
              )}
              <div className="mt-1.5 border-t border-zinc-800/80 pt-1.5 text-[10px] leading-snug text-zinc-600">{st.hint}</div>
            </div>
          );
        })}
      </div>

      <p className="max-w-3xl text-[11px] leading-relaxed text-zinc-600">
        Каждый тип сигнала оценивается автоматически через 30 минут после срабатывания: направленные паттерны
        (робот, свип, киты, фандинг) — симуляцией сделки с тейком и стопом 1:1, засчитывается то, что цена
        задела первой (в пределах одной минутной свечи приоритет у стопа); спред — по схлопыванию
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

