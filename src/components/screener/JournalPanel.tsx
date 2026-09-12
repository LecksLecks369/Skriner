'use client';

import { useEffect, useState } from 'react';
import { EX_MAP } from './format';
import type { ExchangeId } from '@/lib/screener/types';

interface Signal {
  ts: number;
  symbol: string;
  spreadPct: number;
  zScore: number | null;
  score: number;
  hiExchange: ExchangeId;
  loExchange: ExchangeId;
  outcomeConv?: boolean;
}

interface JournalResp {
  summary: { signals24h: number; conv30m: number | null; convN: number; pending: number; legacy: number; total: number };
  signals: Signal[];
}

export function JournalPanel() {
  const [data, setData] = useState<JournalResp | null>(null);

  useEffect(() => {
    const load = () =>
      void fetch('/api/journal', { cache: 'no-store' })
        .then((r) => r.json())
        .then(setData)
        .catch(() => undefined);
    load();
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="space-y-3 p-3 sm:p-5">
      <div className="grid grid-cols-3 gap-2 text-center sm:max-w-md">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
          <div className="text-[10px] uppercase text-zinc-600">сигналов 24ч</div>
          <div className="font-mono text-lg tabular-nums text-zinc-100">{data?.summary.signals24h ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
          <div className="text-[10px] uppercase text-zinc-600">разрыв сжался</div>
          {/* Не emerald: это не прибыль. Зелёная цифра рядом со словом «сошлось»
              читалась как win-rate, хотя схлопывание разрыва ничего не говорит о
              результате сделки — круг регулярно стоит дороже разрыва. */}
          <div className="font-mono text-lg tabular-nums text-zinc-100">
            {data?.summary.conv30m != null ? `${Math.round(data.summary.conv30m * 100)}%` : '—'}
          </div>
          <div className="text-[9px] tabular-nums text-zinc-600">
            n={data?.summary.convN ?? 0}
            {data?.summary.pending ? ` · ждёт ${data.summary.pending}` : ''}
            {data?.summary.legacy ? ` · вне вопроса ${data.summary.legacy}` : ''}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
          <div className="text-[10px] uppercase text-zinc-600">всего в журнале</div>
          <div className="font-mono text-lg tabular-nums text-zinc-100">{data?.summary.total ?? '—'}</div>
        </div>
      </div>
      <p className="max-w-2xl text-[11px] leading-relaxed text-zinc-600">
        «Разрыв сжался» = ГРОСС-разрыв котировок сократился вдвое и более в окне [25; 30] минут
        после сигнала. Это утверждение о рынке, а не о сделке: круг тейкером с проскальзыванием
        обеих ног регулярно стоит дороже самого разрыва, поэтому схлопывание не означает прибыли —
        результат сделки с полными издержками живёт во вкладке «История» (матожидание и его
        интервал). «Ждёт» — данных ещё нет, разрешится временем; «вне вопроса» — строки, записанные
        до разделения гросса и нетто, гросс в них не восстановить. Журнал персистентный.
      </p>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-[10px] uppercase text-zinc-600">
              <th className="px-3 py-2 font-medium">время</th>
              <th className="px-3 py-2 font-medium">монета</th>
              <th className="px-3 py-2 text-right font-medium">разрыв</th>
              <th className="px-3 py-2 text-right font-medium">z</th>
              <th className="px-3 py-2 text-right font-medium">скор</th>
              <th className="px-3 py-2 font-medium">направление</th>
              <th className="px-3 py-2 text-right font-medium">исход</th>
            </tr>
          </thead>
          <tbody>
            {(data?.signals || []).map((s) => (
              <tr key={`${s.symbol}-${s.ts}`} className="border-b border-zinc-900/70">
                <td className="px-3 py-1.5 tabular-nums text-zinc-500">
                  {new Date(s.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="px-3 py-1.5 font-semibold text-zinc-200">{s.symbol.replace(/USDT$/, '')}</td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-emerald-400">
                  +{s.spreadPct.toFixed(2)}%
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-zinc-400">
                  {s.zScore != null ? s.zScore.toFixed(1) : '—'}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-zinc-400">{s.score}</td>
                <td className="px-3 py-1.5">
                  <span style={{ color: EX_MAP[s.loExchange]?.color }}>{EX_MAP[s.loExchange]?.name}</span>
                  <span className="text-zinc-600"> → </span>
                  <span style={{ color: EX_MAP[s.hiExchange]?.color }}>{EX_MAP[s.hiExchange]?.name}</span>
                </td>
                <td className="px-3 py-1.5 text-right">
                  {s.outcomeConv === undefined ? (
                    <span className="text-zinc-700">ждёт…</span>
                  ) : s.outcomeConv ? (
                    <span className="text-emerald-400">сошёлся</span>
                  ) : (
                    <span className="text-rose-400">расширился</span>
                  )}
                </td>
              </tr>
            ))}
            {!data?.signals.length && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-zinc-700">
                  Пока пусто: журнал наполняется, когда нетто-разрыв ≥ 0.25%
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

