'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { CoinRow, ScanResponse } from '@/lib/screener/types';
import { EX_MAP } from '@/components/screener/format';

/* Режим «Радар»: второй монитор, только топ сигналов, крупный шрифт. */

function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 990;
    gain.gain.setValueAtTime(0.14, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* autoplay policy */
  }
}

export default function RadarPage() {
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [threshold, setThreshold] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.25;
    return parseFloat(window.localStorage.getItem('ms_radar_thr') || '0.25') || 0.25;
  });
  const [sound, setSound] = useState(true);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    window.localStorage.setItem('ms_radar_thr', String(threshold));
  }, [threshold]);

  const pick = useCallback(
    (rows: CoinRow[]): CoinRow[] => {
      const sig = rows.filter((r) => r.netSpreadPct != null && r.netSpreadPct >= threshold);
      const pool = sig.length >= 4 ? sig : [...rows].sort((a, b) => b.score - a.score).slice(0, 14);
      return pool.sort((a, b) => b.score - a.score).slice(0, 12);
    },
    [threshold]
  );

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/scan?top=80', { cache: 'no-store' });
        if (!res.ok) return;
        const j = (await res.json()) as ScanResponse;
        if (!alive) return;
        setScan(j);
        const fresh = pick(j.rows).filter((r) => r.netSpreadPct != null && r.netSpreadPct >= threshold);
        for (const r of fresh) {
          if (!seenRef.current.has(r.symbol)) {
            seenRef.current.add(r.symbol);
            if (sound) beep();
          }
        }
        // чистим seen от исчезнувших
        if (seenRef.current.size > 200) seenRef.current = new Set(fresh.map((r) => r.symbol));
      } catch {
        /* ignore */
      }
    };
    void load();
    const iv = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, 30_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [pick, sound, threshold]);

  const top = scan ? pick(scan.rows) : [];
  const updated = scan ? Math.max(0, Math.round((Date.now() - scan.ts) / 1000)) : null;

  return (
    <div className="min-h-screen bg-zinc-950 p-4 text-zinc-200">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href="/" className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100">
          ← скринер
        </Link>
        <h1 className="text-xl font-bold tracking-tight">
          Радар<span className="text-emerald-400"> · топ сигналов</span>
        </h1>
        <label className="flex items-center gap-1.5 text-sm text-zinc-400">
          нетто ≥
          <input
            type="number"
            step="0.05"
            min="0.05"
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value) || 0.25)}
            className="h-8 w-20 rounded-md border border-zinc-800 bg-zinc-900 px-2 font-mono text-sm tabular-nums"
          />
          %
        </label>
        <button
          onClick={() => setSound(!sound)}
          className={`rounded-md border px-3 py-1.5 text-sm ${sound ? 'border-emerald-500/40 text-emerald-400' : 'border-zinc-800 text-zinc-500'}`}
        >
          {sound ? '🔔 звук вкл' : '🔕 звук выкл'}
        </button>
        <span className="ml-auto text-xs text-zinc-600">
          {updated != null ? `обновлено ${updated}s назад` : 'загрузка…'} · F5 — полный экран
        </span>
      </div>

      {top.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-lg text-zinc-700">Сигналов нет — рынок спокоен</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {top.map((r) => {
            const hot = (r.netSpreadPct ?? 0) >= threshold;
            return (
              <div
                key={r.symbol}
                className={`rounded-xl border p-4 ${hot ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-900/40'}`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-bold tracking-tight text-zinc-50">
                    {r.symbol.replace(/USDT$/, '')}
                  </span>
                  <span
                    className={`font-mono text-3xl font-bold tabular-nums ${hot ? 'text-emerald-400' : 'text-zinc-500'}`}
                  >
                    {r.netSpreadPct != null ? `+${r.netSpreadPct.toFixed(2)}%` : '—'}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between text-sm">
                  {r.bestBid && r.bestAsk && r.bestBid.exchange !== r.bestAsk.exchange ? (
                    <span className="text-base">
                      <span style={{ color: EX_MAP[r.bestAsk.exchange].color }}>{EX_MAP[r.bestAsk.exchange].name}</span>
                      <span className="text-zinc-600"> → </span>
                      <span style={{ color: EX_MAP[r.bestBid.exchange].color }}>{EX_MAP[r.bestBid.exchange].name}</span>
                    </span>
                  ) : (
                    <span className="text-zinc-700">—</span>
                  )}
                  <span className="font-mono text-lg font-bold text-amber-400 tabular-nums">{r.score}</span>
                </div>
                <div className="mt-2 flex gap-3 text-xs text-zinc-500">
                  <span>z {r.zScore != null ? r.zScore.toFixed(1) : '—'}</span>
                  <span>{r.spreadAgeMin != null ? `${r.spreadAgeMin}м` : '—'}</span>
                  <span>бирж {r.coverage}</span>
                  {r.whaleNetUsd != null && Math.abs(r.whaleNetUsd) >= 100_000 && (
                    <span className={r.whaleNetUsd > 0 ? 'text-emerald-500' : 'text-rose-500'}>
                      🐋 {r.whaleNetUsd > 0 ? '+' : ''}{Math.round(r.whaleNetUsd / 1000)}K
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

