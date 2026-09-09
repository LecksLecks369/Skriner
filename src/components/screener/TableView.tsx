'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CoinRow } from '@/lib/screener/types';
import type { Filters } from './useScreener';
import {
  ExchangeBadges,
  EX_MAP,
  ScorePill,
  Sparkline,
  fmtAge,
  fmtFunding,
  fmtPct,
  fmtPrice,
  fmtTurnover,
  spreadColor,
} from './format';

export interface SortSpec {
  key: string;
  dir: 'asc' | 'desc';
}

function cell(v: string, cls = ''): string {
  return v === '—' ? 'text-zinc-700' : cls;
}

export function filterAndSort(
  rows: CoinRow[],
  filters: Filters,
  watchlist: string[],
  threshold: number
): CoinRow[] {
  const q = filters.search.trim().toUpperCase();
  let out = rows.filter((r) => {
    if (q && !r.symbol.includes(q)) return false;
    if (r.turnoverUsd < filters.minTurnoverM * 1e6) return false;
    if ((r.crossSpreadPct ?? 0) < filters.minSpread) return false;
    if ((r.netSpreadPct ?? -Infinity) < filters.minNet) return false;
    if (r.score < filters.minScore) return false;
    if (r.coverage < filters.minCoverage) return false;
    if (filters.minZ > 0 && (r.zScore ?? 0) < filters.minZ) return false;
    if (filters.minBasis > 0 && Math.abs(r.spotBasisPct ?? 0) < filters.minBasis) return false;
    if (filters.minFundingSpread > 0 && (r.fundingSpreadPct ?? 0) < filters.minFundingSpread) return false;
    if (filters.minWhale > 0 && Math.abs(r.whaleNetUsd ?? 0) < filters.minWhale * 1000) return false;
    if (filters.minLiq > 0 && (r.liq15mUsd ?? 0) < filters.minLiq * 1000) return false;
    // пробой фильтруем только «до уровня»: вышедшая за уровень цена — уже не прогноз
    if (filters.minBreakout > 0 && !(r.breakout && r.breakout.ready && r.breakout.score >= filters.minBreakout)) return false;
    if (filters.onlyErsh && !r.chop?.isErsh) return false;
    if (filters.onlyDist && !r.dist?.dir) return false;
    if (filters.onlyWatchlist && !watchlist.includes(r.symbol)) return false;
    if (filters.exchanges.length) {
      const ids = r.exchanges.map((x) => x.exchange);
      if (!filters.exchanges.every((e) => ids.includes(e))) return false;
    }
    return true;
  });
  const key = filters.sortKey;
  const dir = filters.sortDir === 'asc' ? 1 : -1;
  out = [...out].sort((a, b) => {
    const va = getSortVal(a, key, threshold);
    const vb = getSortVal(b, key, threshold);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * dir;
    return ((va as number) - (vb as number)) * dir;
  });
  return out;
}

function getSortVal(r: CoinRow, key: string, threshold: number): number | string | null {
  switch (key) {
    case 'symbol':
      return r.symbol;
    case 'price':
      return r.price;
    case 'score':
      return r.score;
    case 'spread':
      return r.crossSpreadPct;
    case 'net':
      return r.netSpreadPct ?? (r.crossSpreadPct != null ? r.crossSpreadPct - 0.12 : null);
    case 'z':
      return r.zScore;
    case 'age':
      return r.spreadAgeMin ?? (r.crossSpreadPct != null && r.crossSpreadPct >= threshold ? 0 : null);
    case 'funding':
      return r.fundingAbs;
    case 'oi':
      return r.oiUsdMax;
    case 'doi':
      return r.dOiPct15m != null ? Math.abs(r.dOiPct15m) : null;
    case 'natr':
      return r.natrPctMax;
    case 'turnover':
      return r.turnoverUsd;
    case 'cvd':
      return r.cvdTaker ?? r.cvdProxy;
    case 'basis':
      return r.spotBasisPct != null ? Math.abs(r.spotBasisPct) : null;
    case 'fds':
      return r.fundingSpreadPct;
    case 'whale':
      return r.whaleNetUsd;
    case 'liq':
      return r.liq15mUsd;
    case 'lsr':
      return r.lsrLongPct;
    case 'rep':
      return r.rep?.winRate ?? null;
    case 'algo':
      return r.deep?.algoScore ?? r.algoProxy;
    case 'illiq':
      return r.deep?.illiqScore ?? r.illiqProxy;
    case 'breakout':
      return r.breakout && r.breakout.ready ? r.breakout.score : null;
    case 'chop':
      return r.chop?.score ?? null;
    case 'dist':
      return r.dist?.dir ? r.dist.score : null;
    case 'coverage':
      return r.coverage;
    default:
      return r.score;
  }
}

const COLS: Array<{ key: string; label: string; title: string; cls?: string }> = [
  { key: 'symbol', label: 'Монета', title: 'Символ + покрытие биржами' },
  { key: 'price', label: 'Цена', title: 'Медианная цена', cls: 'hidden lg:table-cell' },
  { key: 'score', label: 'Скор', title: 'Композитный скор 0–100 (волатильность, OI, свипы, спред, мультибиржевость, фандинг)' },
  { key: 'breakout', label: 'Пробой', title: 'Готовность к пробою 0–100: сжатие волатильности + прижатие к границе диапазона + набор OI + агрессия в сторону выхода. Стрелка — сторона уровня. Сигналом считается только цена в пределах 0.5 ATR от уровня и ДО выхода за него: дальше 0.5 ATR матожидание измерено отрицательным (−0.284%, интервал целиком ниже нуля), после выхода это уже не прогноз. В обоих случаях — прочерк' },
  { key: 'chop', label: 'Ёрш', title: 'Пила: низкий коэффициент эффективности, свечи с длинными тенями, стопы снимают с обеих сторон. В такой монете пробои чаще ложные — сигнал пробоя штрафуется' },
  { key: 'dist', label: 'Раздача', title: 'Расхождение потока и цены внутри пампа/дампа: рост на падающем OI, продажи в рост, толпа набилась в ту же сторону. Контр-сигнал против движения' },
  { key: 'spread', label: 'Спред', title: 'Межбиржевой спред (max-min)/mid' },
  { key: 'net', label: 'Нетто', title: 'Спред после taker-комиссий обеих бирж — торгуемый разрыв' },
  { key: 'z', label: 'Z', title: 'Z-score спреда против его собственной истории' },
  { key: 'age', label: 'Возраст', title: 'Сколько минут держится сигнал' },
  { key: 'hi', label: 'Дороже/Дешевле', title: 'Где купить дешевле → где продать дороже', cls: 'hidden xl:table-cell' },
  { key: 'basis', label: 'Базис', title: 'Перпетуал vs спот, % — переплата фьючерса к споту', cls: 'hidden min-[1750px]:table-cell' },
  { key: 'fds', label: 'ФандΔ', title: 'Разброс фандинга между биржами — кандидат в кари-трейд', cls: 'hidden min-[1650px]:table-cell' },
  { key: 'whale', label: 'Киты', title: 'Нетто китовых сделок Bybit (>$50k) за 5 минут', cls: 'hidden min-[1850px]:table-cell' },
  { key: 'liq', label: 'Ликв', title: 'Ликвидации за 15 минут на OKX (USD). Каскад — сильный импульсный сигнал: лонги вынесены → возможен отскок вверх', cls: 'hidden min-[1750px]:table-cell' },
  { key: 'lsr', label: 'Л/Ш', title: 'Доля аккаунтов розницы в лонгах (Bybit/OKX, 5м). Толпа в лонгах ≥65% — топливо для лонг-сквиза вниз; ≤40% — для шорт-сквиза вверх', cls: 'hidden min-[1950px]:table-cell' },
  { key: 'funding', label: 'Фандинг', title: 'Максимальный |фандинг| среди бирж', cls: 'hidden md:table-cell' },
  { key: 'doi', label: 'ΔOI 15м', title: 'Изменение открытого интереса за 15 минут', cls: 'hidden xl:table-cell' },
  { key: 'oi', label: 'OI', title: 'Открытый интерес (макс)', cls: 'hidden lg:table-cell' },
  { key: 'natr', label: 'NATR', title: 'Нормированная волатильность 1м', cls: 'hidden 2xl:table-cell' },
  { key: 'cvd', label: 'CVD*', title: 'Агрессия по свечам 15м (прокси) — BingX удалил свой taker-endpoint', cls: 'hidden 2xl:table-cell' },
  { key: 'rep', label: 'Реп', title: 'Репутация монеты: доля её сигналов, сошедшихся за 30м', cls: 'hidden min-[1750px]:table-cell' },
  { key: 'algo', label: 'Алго', title: 'Всплеск алго-активности: клипы/агрессия из ленты (топ-40 по скору) либо прокси по объёму+ΔOI. Точный разбор — раздел «Неликвид»', cls: 'hidden xl:table-cell' },
  { key: 'illiq', label: 'Неликв', title: 'Неликвидность 0-100: глубина стакана, слипейдж, Амихуд, оборот (для топ-40) либо прокси. Раздел «Неликвид»', cls: 'hidden xl:table-cell' },
  { key: 'turnover', label: 'Оборот', title: 'Максимальный 24h оборот', cls: 'hidden md:table-cell' },
  { key: 'spark', label: '', title: 'Цена 60м', cls: 'hidden md:table-cell' },
];

export function TableView({
  rows,
  filters,
  setFilters,
  watchlist,
  toggleWatch,
  threshold,
  onOpen,
}: {
  rows: CoinRow[];
  filters: Filters;
  setFilters: (f: Partial<Filters>) => void;
  watchlist: string[];
  toggleWatch: (s: string) => void;
  threshold: number;
  onOpen: (r: CoinRow) => void;
}) {
  const th = useMemo(
    () => (key: string) =>
      ({
        onClick: () => setFilters({ sortKey: key, sortDir: filters.sortKey === key && filters.sortDir === 'desc' ? 'asc' : 'desc' }),
        className: `cursor-pointer select-none hover:text-zinc-200 ${filters.sortKey === key ? 'text-emerald-400' : ''}`,
      }) as const,
    [filters.sortKey, filters.sortDir, setFilters]
  );

  // инкрементальный рендер: сначала 60 строк, догружаем при скролле
  const [limit, setLimit] = useState(60);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setLimit((l) => l + 60);
      },
      { rootMargin: '500px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  if (limit > rows.length + 120) setLimit(60);
  const shown = rows.slice(0, limit);

  if (!rows.length) {
    return (
      <div className="px-5 py-16 text-center text-sm text-zinc-600">
        Нет монет под фильтры — ослабьте условия или подождите наполнения истории
      </div>
    );
  }

  return (
    <>
      {/* Desktop-таблица */}
      <div className="hidden md:block">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-zinc-800 text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="w-8 px-2 py-2" />
              {COLS.map((c) => (
                <th key={c.key} title={c.title} className={`px-2 py-2 text-left font-medium ${c.cls || ''} ${th(c.key).className}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const watched = watchlist.includes(r.symbol);
              return (
                <tr
                  key={r.symbol}
                  onClick={() => onOpen(r)}
                  className="group cursor-pointer border-b border-zinc-900/70 hover:bg-zinc-900/50"
                >
                  <td className="px-2 py-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleWatch(r.symbol);
                      }}
                      className={watched ? 'text-amber-400' : 'text-zinc-700 hover:text-zinc-400'}
                      title={watched ? 'Убрать из watchlist' : 'В watchlist'}
                    >
                      {watched ? '★' : '☆'}
                    </button>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-zinc-100">{r.symbol.replace(/USDT$/, '')}</span>
                      <span className="text-[10px] text-zinc-600">USDT</span>
                      <ExchangeBadges row={r} />
                      {r.sweepFresh && r.sweepFresh.ageMin <= 15 && (
                        <span
                          title={`Снятие ликвидности ${r.sweepFresh.dir === 'up' ? 'сверху' : 'снизу'}, ${r.sweepFresh.ageMin}м, тень ${r.sweepFresh.wickAtr}×ATR`}
                          className="rounded bg-fuchsia-500/15 px-1 text-[10px] font-semibold text-fuchsia-400"
                        >
                          SWEEP
                        </span>
                      )}
                      {r.breakout && r.breakout.ready && r.breakout.score >= 60 && (
                        <span
                          title={`Готовится пробой ${r.breakout.dir === 'up' ? 'вверх' : 'вниз'}: ${r.breakout.reasons.join(' · ')}`}
                          className="rounded bg-emerald-500/15 px-1 text-[10px] font-semibold text-emerald-400"
                        >
                          ПРОБОЙ {r.breakout.dir === 'up' ? '↑' : '↓'}
                        </span>
                      )}
                      {r.chop?.isErsh && (
                        <span
                          title={`Ёрш: пила, ложные пробои (эффективность ${r.chop.er})`}
                          className="rounded bg-orange-500/15 px-1 text-[10px] font-semibold text-orange-400"
                        >
                          ЁРШ
                        </span>
                      )}
                      {r.dist?.dir && (
                        <span
                          title={`${r.dist.kind === 'pump_distribution' ? 'Раздача в памп' : 'Набор в дамп'}: ${r.dist.reasons.join(' · ')}`}
                          className={`rounded px-1 text-[10px] font-semibold ${
                            r.dist.kind === 'pump_distribution' ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400'
                          }`}
                        >
                          {r.dist.kind === 'pump_distribution' ? 'РАЗДАЧА' : 'НАБОР'}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={`px-2 py-1.5 font-mono tabular-nums text-zinc-300 ${cell(fmtPrice(r.price))} hidden lg:table-cell`}>
                    {fmtPrice(r.price)}
                  </td>
                  <td className="px-2 py-1.5">
                    <ScorePill score={r.score} />
                  </td>
                  <td className="px-2 py-1.5">
                    {r.breakout && r.breakout.ready ? (
                      <span
                        title={`${r.breakout.reasons.join(' · ')} · уровень ${fmtPrice(r.breakout.level)} · диапазон ${r.breakout.rangePct}% · тестов ${r.breakout.touches}`}
                        className={`font-mono text-xs tabular-nums ${
                          r.breakout.score >= 60 ? 'font-semibold text-emerald-400' : r.breakout.score >= 40 ? 'text-lime-400' : 'text-zinc-500'
                        }`}
                      >
                        {r.breakout.dir === 'up' ? '↑' : '↓'}
                        {r.breakout.score}
                      </span>
                    ) : (
                      <span className="text-zinc-700" title={r.breakout?.fired ? 'цена уже вышла за уровень — не прогноз' : r.breakout ? `до уровня ${r.breakout.distAtr} ATR — дальше 0.5 ATR сигнал не выдаётся` : 'нет диапазона для уровня'}>
                        —
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.chop ? (
                      <span
                        title={`эффективность ${r.chop.er} · смены направления ${r.chop.flips} · тени ${Math.round(r.chop.wickRatio * 100)}%${r.chop.bothSides ? ' · стопы снимали с обеих сторон' : ''}`}
                        className={`font-mono text-xs tabular-nums ${
                          r.chop.isErsh ? 'font-semibold text-orange-400' : r.chop.score >= 40 ? 'text-amber-400/70' : 'text-zinc-500'
                        }`}
                      >
                        {r.chop.score}
                      </span>
                    ) : (
                      <span className="text-zinc-700">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.dist?.dir ? (
                      <span
                        title={r.dist.reasons.join(' · ')}
                        className={`rounded px-1 text-[10px] font-semibold ${
                          r.dist.kind === 'pump_distribution' ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400'
                        }`}
                      >
                        {r.dist.kind === 'pump_distribution' ? 'РАЗДАЧА' : 'НАБОР'} {r.dist.score}
                      </span>
                    ) : r.dist ? (
                      <span className="text-[10px] text-zinc-600" title={r.dist.reasons.join(' · ')}>
                        тренд
                      </span>
                    ) : (
                      <span className="text-zinc-700">—</span>
                    )}
                  </td>
                  <td className={`px-2 py-1.5 font-mono tabular-nums ${spreadColor(r.crossSpreadPct, threshold)}`}>
                    {fmtPct(r.crossSpreadPct)}
                  </td>
                  <td className={`px-2 py-1.5 font-mono tabular-nums ${spreadColor(r.netSpreadPct, threshold)}`}>
                    {fmtPct(r.netSpreadPct)}
                  </td>
                  <td className={`px-2 py-1.5 font-mono tabular-nums ${r.zScore != null && r.zScore >= 2 ? 'text-emerald-400' : 'text-zinc-400'}`}>
                    {r.zScore != null ? r.zScore.toFixed(1) : '—'}
                  </td>
                  <td className={`px-2 py-1.5 text-zinc-400 ${cell(r.spreadAgeMin != null ? 'x' : '')}`}>
                    {fmtAge(r.spreadAgeMin)}
                  </td>
                  <td className="hidden px-2 py-1.5 xl:table-cell">
                    {r.bestBid && r.bestAsk && r.bestBid.exchange !== r.bestAsk.exchange ? (
                      <span className="text-[11px]">
                        <span style={{ color: EX_MAP[r.bestAsk.exchange].color }} title={`Купить дешевле на ${EX_MAP[r.bestAsk.exchange].name}`}>
                          {EX_MAP[r.bestAsk.exchange].name}
                        </span>
                        <span className="text-zinc-600"> → </span>
                        <span style={{ color: EX_MAP[r.bestBid.exchange].color }} title={`Продать дороже на ${EX_MAP[r.bestBid.exchange].name}`}>
                          {EX_MAP[r.bestBid.exchange].name}
                        </span>
                      </span>
                    ) : (
                      <span className="text-zinc-700">—</span>
                    )}
                  </td>
                  <td className="hidden px-2 py-1.5 min-[1750px]:table-cell">
                    {r.spotBasisPct != null ? (
                      <span
                        className={`font-mono tabular-nums ${Math.abs(r.spotBasisPct) >= 0.3 ? (r.spotBasisPct > 0 ? 'text-rose-400' : 'text-emerald-400') : 'text-zinc-400'}`}
                        title={r.spotBasis ? `Базис на ${EX_MAP[r.spotBasis.ex].name}: перп ${fmtPrice(r.spotBasis.perp)} vs спот ${fmtPrice(r.spotBasis.spot)}` : 'Перпетуал vs спот'}
                      >
                        {r.spotBasisPct >= 0 ? '+' : ''}{r.spotBasisPct.toFixed(2)}%
                      </span>
                    ) : (
                      <span className="text-zinc-700">—</span>
                    )}
                  </td>
                  <td className={`hidden px-2 py-1.5 font-mono tabular-nums min-[1650px]:table-cell ${(r.fundingSpreadPct ?? 0) >= 0.02 ? 'text-amber-400' : 'text-zinc-400'}`}>
                    {r.fundingSpreadPct != null ? r.fundingSpreadPct.toFixed(3) : '—'}
                  </td>
                  <td className={`hidden px-2 py-1.5 font-mono tabular-nums min-[1850px]:table-cell ${r.whaleNetUsd != null && Math.abs(r.whaleNetUsd) >= 100_000 ? (r.whaleNetUsd > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-500'}`}>
                    {r.whaleNetUsd != null ? `${r.whaleNetUsd > 0 ? '+' : ''}${Math.round(r.whaleNetUsd / 1000)}K` : '—'}
                  </td>
                  <td className={`hidden px-2 py-1.5 font-mono tabular-nums min-[1750px]:table-cell ${(r.liq15mUsd ?? 0) >= 100_000 ? 'text-rose-400' : (r.liq15mUsd ?? 0) > 0 ? 'text-amber-400' : 'text-zinc-500'}`} title={r.liq15mUsd != null && r.liq15mUsd > 0 ? `За 15м: лонги ${Math.round((r.liqLongUsd ?? 0) / 1000)}K / шорты ${Math.round((r.liqShortUsd ?? 0) / 1000)}K · за 5м ${Math.round((r.liq5mUsd ?? 0) / 1000)}K` : 'Ликвидации OKX за 15м'}>
                    {r.liq15mUsd != null && r.liq15mUsd > 0 ? `${Math.round(r.liq15mUsd / 1000)}K` : '—'}
                  </td>
                  <td className={`hidden px-2 py-1.5 font-mono tabular-nums min-[1950px]:table-cell ${r.lsrLongPct != null ? (r.lsrLongPct >= 65 ? 'text-rose-400' : r.lsrLongPct <= 40 ? 'text-emerald-400' : 'text-zinc-400') : 'text-zinc-700'}`} title={r.lsrLongPct != null ? `${r.lsrEx === 'bybit' ? 'Bybit account-ratio' : 'OKX'}: лонги ${r.lsrLongPct}% · L/S ${r.lsrRatio ?? '—'}` : ''}>
                    {r.lsrLongPct != null ? `${Math.round(r.lsrLongPct)}%` : '—'}
                  </td>
                  <td className={`hidden px-2 py-1.5 font-mono tabular-nums md:table-cell ${r.fundingAbs != null && r.fundingAbs >= 0.0005 ? 'text-rose-400' : 'text-zinc-400'}`}>
                    {fmtFunding(r.fundingAbs)}
                  </td>
                  <td className={`hidden px-2 py-1.5 font-mono tabular-nums xl:table-cell ${r.dOiPct15m != null && Math.abs(r.dOiPct15m) >= 0.8 ? 'text-emerald-400' : 'text-zinc-400'}`}>
                    {r.dOiPct15m != null ? `${r.dOiPct15m >= 0 ? '+' : ''}${r.dOiPct15m.toFixed(2)}%` : '—'}
                  </td>
                  <td className={`hidden px-2 py-1.5 font-mono tabular-nums text-zinc-400 lg:table-cell ${cell(r.oiUsdMax != null ? 'x' : '')}`}>
                    {fmtTurnover(r.oiUsdMax)}
                  </td>
                  <td className={`hidden px-2 py-1.5 font-mono tabular-nums text-zinc-400 2xl:table-cell ${cell(r.natrPctMax != null ? 'x' : '')}`}>
                    {r.natrPctMax != null ? `${r.natrPctMax.toFixed(2)}%` : '—'}
                  </td>
                  <td className={`hidden px-2 py-1.5 font-mono tabular-nums 2xl:table-cell ${r.cvdTaker != null && Math.abs(r.cvdTaker) >= 0.25 ? (r.cvdTaker > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-500'}`}>
                    {(() => {
                      const cv = r.cvdTaker ?? r.cvdProxy;
                      return cv != null ? cv.toFixed(2) : '—';
                    })()}
                  </td>
                  <td className={`hidden px-2 py-1.5 font-mono tabular-nums min-[1750px]:table-cell ${r.rep?.winRate != null && r.rep.winRate >= 0.6 ? 'text-emerald-400' : 'text-zinc-400'}`} title={r.rep ? `Сигналов: ${r.rep.n}` : ''}>
                    {r.rep?.winRate != null ? `${Math.round(r.rep.winRate * 100)}%` : '—'}
                  </td>
                  <td className="hidden px-2 py-1.5 xl:table-cell">
                    {(() => {
                      const v = r.deep?.algoScore ?? r.algoProxy;
                      if (v == null) return <span className="text-zinc-700">—</span>;
                      const proxy = !r.deep;
                      return (
                        <span
                          className={`font-mono text-xs tabular-nums ${v >= 70 ? 'text-rose-400' : v >= 55 ? 'text-amber-400' : v >= 35 ? 'text-zinc-300' : 'text-zinc-500'} ${proxy ? 'opacity-60' : ''}`}
                          title={proxy ? 'Прокси без ленты сделок' : 'Точный скор по ленте+стакану'}
                        >
                          {v}
                          {proxy ? '*' : ''}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="hidden px-2 py-1.5 xl:table-cell">
                    {(() => {
                      const v = r.deep?.illiqScore ?? r.illiqProxy;
                      if (v == null) return <span className="text-zinc-700">—</span>;
                      const proxy = !r.deep;
                      return (
                        <span
                          className={`font-mono text-xs tabular-nums ${v >= 70 ? 'text-rose-400' : v >= 50 ? 'text-amber-400' : v >= 30 ? 'text-zinc-300' : 'text-zinc-500'} ${proxy ? 'opacity-60' : ''}`}
                          title={proxy ? 'Прокси: Амихуд+оборот+спред' : 'Глубина+слипейдж+Амихуд+оборот'}
                        >
                          {v}
                          {proxy ? '*' : ''}
                        </span>
                      );
                    })()}
                  </td>
                  <td className={`hidden px-2 py-1.5 font-mono tabular-nums text-zinc-400 md:table-cell ${cell(fmtTurnover(r.turnoverUsd))}`}>
                    {fmtTurnover(r.turnoverUsd)}
                  </td>
                  <td className="hidden px-2 py-1 md:table-cell">
                    <Sparkline data={r.spark} color={r.spark.length > 1 && r.spark[r.spark.length - 1] >= r.spark[0] ? '#34d399' : '#f87171'} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div ref={sentinelRef} className="h-px" />
      {rows.length > limit && (
        <div className="py-3 text-center text-xs text-zinc-600">показано {limit} из {rows.length} — прокрути для остальных</div>
      )}

      {/* Mobile-карточки */}
      <div className="space-y-2 p-3 md:hidden">
        {shown.map((r) => (
          <button
            key={r.symbol}
            onClick={() => onOpen(r)}
            className="block w-full rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-left active:bg-zinc-900"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`text-base ${watchlist.includes(r.symbol) ? 'text-amber-400' : 'text-zinc-600'}`}>
                  {watchlist.includes(r.symbol) ? '★' : '☆'}
                </span>
                <span className="font-semibold text-zinc-100">{r.symbol.replace(/USDT$/, '')}</span>
                <ExchangeBadges row={r} size="xs" />
              </div>
              <ScorePill score={r.score} />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-[10px] text-zinc-600">спред</div>
                <div className={`font-mono text-sm tabular-nums ${spreadColor(r.crossSpreadPct, threshold)}`}>
                  {fmtPct(r.crossSpreadPct)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-zinc-600">нетто</div>
                <div className={`font-mono text-sm tabular-nums ${spreadColor(r.netSpreadPct, threshold)}`}>
                  {fmtPct(r.netSpreadPct)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-zinc-600">z-score</div>
                <div className="font-mono text-sm tabular-nums text-zinc-300">
                  {r.zScore != null ? r.zScore.toFixed(1) : '—'}
                </div>
              </div>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[10px] text-zinc-500">
              <span>
                {r.bestBid && r.bestAsk && r.bestBid.exchange !== r.bestAsk.exchange
                  ? `${EX_MAP[r.bestAsk.exchange].name} → ${EX_MAP[r.bestBid.exchange].name}`
                  : '—'}
              </span>
              <span>
                {r.whaleNetUsd != null && Math.abs(r.whaleNetUsd) >= 100_000 && (
                  <span className={r.whaleNetUsd > 0 ? 'text-emerald-500' : 'text-rose-500'}>🐋 </span>
                )}
                {r.breakout && r.breakout.ready && r.breakout.score >= 60 && <span title={`Готовится пробой ${r.breakout.dir === 'up' ? 'вверх' : 'вниз'}`}>⚡ </span>}
                {r.chop?.isErsh && <span title="Ёрш: ложные пробои">〰 </span>}
                {r.dist?.dir && <span title={r.dist.kind === 'pump_distribution' ? 'Раздача в памп' : 'Набор в дамп'}>📦 </span>}
                {(r.deep?.algoScore ?? r.algoProxy ?? 0) >= 55 && <span title="Алго-всплеск">🤖 </span>}
                {(r.deep?.illiqScore ?? r.illiqProxy ?? 0) >= 55 && <span title="Неликвид">💧 </span>}
                {fmtTurnover(r.turnoverUsd)} · {fmtAge(r.spreadAgeMin)}
              </span>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

