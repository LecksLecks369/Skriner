'use client';

import { EXCHANGES, type CoinRow, type ExchangeId } from '@/lib/screener/types';

export const EX_MAP = Object.fromEntries(EXCHANGES.map((e) => [e.id, e])) as Record<
  ExchangeId,
  (typeof EXCHANGES)[number]
>;

export function fmtPrice(p: number): string {
  if (!p) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toPrecision(4);
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !isFinite(v)) return '—';
  return `${v >= 0 ? '' : ''}${v.toFixed(digits)}%`;
}

export function fmtTurnover(usd: number | null | undefined): string {
  if (usd == null || !isFinite(usd)) return '—';
  if (usd >= 1e9) return `${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `${(usd / 1e6).toFixed(1)}M`;
  if (usd >= 1e3) return `${(usd / 1e3).toFixed(0)}K`;
  return usd.toFixed(0);
}

export function fmtAge(min: number | null | undefined): string {
  if (min == null) return '—';
  if (min < 1) return '<1м';
  if (min < 60) return `${Math.round(min)}м`;
  const h = Math.floor(min / 60);
  return `${h}ч ${Math.round(min % 60)}м`;
}

export function fmtFunding(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—';
  const bp = v * 100;
  return `${bp >= 0 ? '+' : ''}${bp.toFixed(3)}%`;
}

export function scoreColor(score: number): string {
  if (score >= 75) return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40';
  if (score >= 55) return 'bg-lime-500/15 text-lime-400 border-lime-500/40';
  if (score >= 35) return 'bg-amber-500/15 text-amber-400 border-amber-500/40';
  if (score > 0) return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/40';
  return 'bg-zinc-800/40 text-zinc-600 border-zinc-700/40';
}

export function spreadColor(v: number | null | undefined, threshold: number): string {
  if (v == null || !isFinite(v)) return 'text-zinc-600';
  if (v >= threshold) return 'text-emerald-400 font-semibold';
  if (v >= threshold * 0.6) return 'text-lime-400';
  if (v >= threshold * 0.3) return 'text-amber-400';
  return 'text-zinc-300';
}

/* ---------- Спарклайн ---------- */
export function Sparkline({
  data,
  w = 88,
  h = 26,
  color = '#34d399',
  fill = true,
}: {
  data: number[];
  w?: number;
  h?: number;
  color?: string;
  fill?: boolean;
}) {
  if (!data || data.length < 2) {
    return <div className="h-[26px] w-[88px] text-[10px] text-zinc-700 flex items-center">нет данных</div>;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - 2 - ((v - min) / range) * (h - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${pts.join(' L')}`;
  return (
    <svg width={w} height={h} className="overflow-visible" aria-hidden>
      {fill && (
        <path
          d={`${line} L${w},${h} L0,${h} Z`}
          fill={color}
          opacity="0.12"
          stroke="none"
        />
      )}
      <path d={line} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- Бейджи бирж (покрытие) ---------- */
export function ExchangeBadges({ row, size = 'sm' }: { row: Pick<CoinRow, 'exchanges'>; size?: 'sm' | 'xs' }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {EXCHANGES.map((e) => {
        const has = row.exchanges.some((x) => x.exchange === e.id);
        return (
          <span
            key={e.id}
            title={has ? `${e.name}: есть монета` : `${e.name}: нет`}
            className={`inline-block rounded-sm border ${
              size === 'sm' ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5'
            }`}
            style={{
              backgroundColor: has ? e.color : 'transparent',
              borderColor: has ? e.color : '#3f3f46',
              opacity: has ? 0.9 : 0.5,
            }}
          />
        );
      })}
    </span>
  );
}

/* ---------- Пилл скора ---------- */
export function ScorePill({ score, onClick }: { score: number; onClick?: () => void }) {
  const cls = `inline-flex min-w-[38px] items-center justify-center rounded-md border px-1.5 py-0.5 text-xs font-mono font-semibold tabular-nums ${scoreColor(score)} ${onClick ? 'cursor-pointer hover:brightness-125' : 'cursor-default'}`;
  if (onClick) {
    return (
      <button onClick={onClick} className={cls} title="Композитный скор 0–100">
        {score}
      </button>
    );
  }
  return (
    <span className={cls} title="Композитный скор 0–100">
      {score}
    </span>
  );
}

