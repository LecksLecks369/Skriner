'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from '@/hooks/use-toast';
import { EX_MAP } from './format';
import type { Settings } from './useScreener';
import type { CoinRow, ExchangeId, ScanResponse } from '@/lib/screener/types';

interface AlertItem {
  symbol: string;
  spreadPct: number | null;
  zScore: number | null;
  score: number;
  ageMin: number | null;
  coverage: number;
  hi?: ExchangeId;
  lo?: ExchangeId;
  ts: number;
}

interface RobotAlertItem {
  symbol: string;
  algoScore: number;
  illiqScore: number;
  netSpreadPct: number | null;
  slip25kPct: number | null;
  maxPosUsd: number | null;
  entryEx?: ExchangeId;
  exitEx?: ExchangeId;
  reasons: string[];
  price: number;
  ts: number;
}

function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
    setTimeout(() => void ctx.close(), 500);
  } catch {
    /* autoplay policy */
  }
}

async function sendExternal(s: Settings, text: string) {
  if (!s.notifyOn) return;
  try {
    if (s.notifyWebhook) {
      void fetch(s.notifyWebhook, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source: 'metascreener', ts: Date.now() }),
      }).catch(() => undefined);
    }
    if (s.notifyTgToken && s.notifyTgChat) {
      void fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: s.notifyTgToken, chatId: s.notifyTgChat, text }),
      }).catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
}

/** Проверка строки по конструктору правил (И/ИЛИ). Возвращает подпись сработавшего правила или null */
export function evalRules(r: CoinRow, s: Settings): string | null {
  const conds: Array<[boolean, string]> = [];
  if (s.rNet > 0) conds.push([(r.netSpreadPct ?? 0) >= s.rNet, `нетто ${r.netSpreadPct?.toFixed(2)}%`]);
  if (s.rZ > 0) conds.push([(r.zScore ?? 0) >= s.rZ, `z ${r.zScore?.toFixed(1)}`]);
  if (s.rScore > 0) conds.push([r.score >= s.rScore, `скор ${r.score}`]);
  if (s.rBasis > 0) conds.push([Math.abs(r.spotBasisPct ?? 0) >= s.rBasis, `базис ${r.spotBasisPct?.toFixed(2)}%`]);
  if (s.rFds > 0) conds.push([(r.fundingSpreadPct ?? 0) >= s.rFds, `фандΔ ${r.fundingSpreadPct?.toFixed(3)}%`]);
  if (s.rWhale > 0) conds.push([Math.abs(r.whaleNetUsd ?? 0) >= s.rWhale * 1000, `киты ${(Math.abs(r.whaleNetUsd ?? 0) / 1000).toFixed(0)}K`]);
  if (s.rLiq > 0) conds.push([(r.liq15mUsd ?? 0) >= s.rLiq * 1000, `ликвидации ${(Math.round((r.liq15mUsd ?? 0) / 1000)).toFixed(0)}K/15м`]);
  if (!conds.length) return null;
  const hit = s.ruleMode === 'and' ? conds.every(([ok]) => ok) : conds.some(([ok]) => ok);
  return hit ? conds.filter(([ok]) => ok).map(([, label]) => label).join(' · ') : null;
}

export function AlertCenter({ settings, paused, scan }: { settings: Settings; paused: boolean; scan: ScanResponse | null }) {
  const [latest, setLatest] = useState<AlertItem[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const cfgRef = useRef(settings);
  const lastAlert = useRef<Map<string, number>>(new Map());
  const lastRule = useRef<Map<string, number>>(new Map());
  const pausedRef = useRef(paused);

  useEffect(() => {
    cfgRef.current = settings;
  }, [settings]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  /* --- SSE-алерты по порогу спреда / скору --- */
  useEffect(() => {
    if (paused) return;
    const connect = () => {
      esRef.current?.close();
      const qs = new URLSearchParams({
        threshold: String(cfgRef.current.thresholdPct),
        minScore: cfgRef.current.alertScoreOn ? String(cfgRef.current.minScoreAlert) : '0',
        ref: cfgRef.current.refExchange,
      });
      const es = new EventSource(`/api/alerts?${qs}`);
      esRef.current = es;
      es.addEventListener('alert', (ev) => {
        try {
          const j = JSON.parse((ev as MessageEvent).data) as { alerts: AlertItem[] };
          const now = Date.now();
          const cooldownMs = cfgRef.current.cooldownMin * 60_000;
          const fresh: AlertItem[] = [];
          for (const a of j.alerts) {
            const last = lastAlert.current.get(a.symbol) || 0;
            if (now - last < cooldownMs) continue;
            lastAlert.current.set(a.symbol, now);
            fresh.push(a);
          }
          if (!fresh.length) return;
          setLatest((prev) => [...fresh, ...prev].slice(0, 30));
          for (const a of fresh) {
            const hiName = a.hi ? EX_MAP[a.hi]?.name : '?';
            const loName = a.lo ? EX_MAP[a.lo]?.name : '?';
            const body = a.spreadPct != null
              ? `нетто ${a.spreadPct.toFixed(2)}% · z ${a.zScore != null ? a.zScore.toFixed(1) : '—'} · ${loName} → ${hiName}`
              : `скор ${a.score}`;
            toast({
              title: `⚠ ${a.symbol} — межбиржевой разрыв`,
              description: body,
              duration: 9000,
            });
            if (cfgRef.current.soundOn) beep();
            if (cfgRef.current.notifOn && 'Notification' in window && Notification.permission === 'granted') {
              new Notification(`${a.symbol}: разрыв ${a.spreadPct != null ? a.spreadPct.toFixed(2) + '%' : ''}`, {
                body,
              });
            }
            void sendExternal(cfgRef.current, `⚠ ${a.symbol}: нетто ${a.spreadPct?.toFixed(2)}% (${loName} → ${hiName}), скор ${a.score}`);
          }
        } catch {
          /* ignore */
        }
      });
      es.addEventListener('robot', (ev) => {
        try {
          const j = JSON.parse((ev as MessageEvent).data) as { alerts: RobotAlertItem[] };
          for (const a of j.alerts) {
            const entry = a.entryEx ? EX_MAP[a.entryEx]?.name : '?';
            const exit = a.exitEx ? EX_MAP[a.exitEx]?.name : '?';
            const body = `алго ${a.algoScore} · неликвид ${a.illiqScore} · нетто ${a.netSpreadPct != null ? a.netSpreadPct.toFixed(2) + '%' : '—'} · max $${a.maxPosUsd != null ? Math.round(a.maxPosUsd / 1000) + 'K' : '—'}${a.reasons.length ? ' · ' + a.reasons.slice(0, 2).join(', ') : ''}`;
            toast({ title: `🤖 ${a.symbol} — робот вошёл в неликвид`, description: body, duration: 12000 });
            if (cfgRef.current.soundOn) beep();
            if (cfgRef.current.notifOn && 'Notification' in window && Notification.permission === 'granted') {
              new Notification(`🤖 ${a.symbol}: робот вошёл в неликвид`, { body });
            }
            void sendExternal(
              cfgRef.current,
              `🤖 ${a.symbol}: робот вошёл в неликвид (алго ${a.algoScore}, неликвид ${a.illiqScore}, нетто ${a.netSpreadPct?.toFixed(2)}%, max $${a.maxPosUsd != null ? Math.round(a.maxPosUsd / 1000) + 'K' : '—'}, вход ${entry} → выход ${exit})`
            );
          }
        } catch {
          /* ignore */
        }
      });
      es.onerror = () => {
        es.close();
        if (!pausedRef.current) setTimeout(connect, 5000); // реконнект
      };
    };
    connect();
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [paused, settings.thresholdPct, settings.alertScoreOn, settings.minScoreAlert, settings.refExchange]);

  /* --- Конструктор правил: клиентская оценка на каждом скане --- */
  const rulesKey = [
    settings.rulesOn, settings.ruleMode, settings.rNet, settings.rZ, settings.rScore,
    settings.rBasis, settings.rFds, settings.rWhale, settings.rLiq,
  ].join('|');
  const scanTs = scan?.ts ?? 0;
  useEffect(() => {
    if (!settings.rulesOn || paused || !scan) return;
    const now = Date.now();
    const cooldownMs = cfgRef.current.cooldownMin * 60_000;
    for (const row of scan.rows) {
      const label = evalRules(row, cfgRef.current);
      if (!label) continue;
      const last = lastRule.current.get(row.symbol) || 0;
      if (now - last < cooldownMs) continue;
      lastRule.current.set(row.symbol, now);
      const body = `${label} · скор ${row.score}`;
      toast({ title: `🎯 ${row.symbol} — правило`, description: body, duration: 9000 });
      if (cfgRef.current.soundOn) beep();
      if (cfgRef.current.notifOn && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(`🎯 ${row.symbol}`, { body });
      }
      void sendExternal(cfgRef.current, `🎯 ${row.symbol}: ${label}, скор ${row.score}`);
    }
  }, [scanTs, rulesKey, paused]);

  if (!latest.length) return null;

  return (
    <div className="fixed bottom-3 right-3 z-50 hidden max-w-[300px] space-y-1.5 sm:block">
      <div className="mb-1 text-right text-[10px] uppercase tracking-wider text-zinc-600">
        живые алерты (SSE)
      </div>
      {latest.slice(0, 4).map((a) => (
        <div
          key={`${a.symbol}-${a.ts}`}
          className="rounded-lg border border-amber-500/30 bg-zinc-950/95 p-2 text-xs shadow-lg backdrop-blur"
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold text-amber-400">{a.symbol}</span>
            <span className="font-mono tabular-nums text-emerald-400">
              {a.spreadPct != null ? `+${a.spreadPct.toFixed(2)}%` : `скор ${a.score}`}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-500">
            {a.lo && a.hi && `${EX_MAP[a.lo]?.name} → ${EX_MAP[a.hi]?.name}`}
            {a.zScore != null ? ` · z ${a.zScore.toFixed(1)}` : ''}
            {a.ageMin != null ? ` · ${a.ageMin}м` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

