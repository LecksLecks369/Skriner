'use client';

import { useRef, useState } from 'react';
import { EXCHANGES, type ExchangeId } from '@/lib/screener/types';
import type { Filters, Preset } from './useScreener';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

interface BtResult {
  hours: number;
  signals: number;
  decided: number;
  winRate: number | null;
  avgNet: number;
  samples: number;
  message?: string;
}

interface OptCombo {
  threshold: number;
  minScore: number;
  cooldownMin: number;
  signals: number;
  decided: number;
  wins: number;
  sls: number;
  timeouts: number;
  winRate: number | null;
  totalPnl: number;
  avgPnl: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  maxDdPct: number;
  tradesPerDay: number;
  /* Сколько сделок комбинации посчитано БЕЗ слипейджа: снимок хранит его только
     с недавних пор и только у монет со стаканом. Это допущение, а не измерение,
     и оно обязано ехать рядом с цифрой — слипейдж круга на живом скане порядка
     1% против 0.18% комиссий, то есть на этой доле матожидание завышено в разы. */
  noSlip?: number;
}

interface OptResult {
  hours: number;
  samples: number;
  message?: string;
  best: OptCombo[];
  current: OptCombo | null;
}

export function Filters({
  filters,
  setFilters,
  presets,
  savePreset,
  applyPreset,
  deletePreset,
  exportPresets,
  importPresets,
  onExportCsv,
  total,
  shown,
}: {
  filters: Filters;
  setFilters: (f: Partial<Filters>) => void;
  presets: Preset[];
  savePreset: (name: string) => void;
  applyPreset: (name: string) => void;
  deletePreset: (name: string) => void;
  exportPresets: () => void;
  importPresets: (f: File) => void;
  onExportCsv: () => void;
  total: number;
  shown: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [presetName, setPresetName] = useState('');
  const [bt, setBt] = useState<BtResult | null>(null);
  const [btBusy, setBtBusy] = useState(false);
  const [opt, setOpt] = useState<OptResult | null>(null);
  const [optBusy, setOptBusy] = useState(false);

  const runOptimizer = async () => {
    setOptBusy(true);
    try {
      const qs = new URLSearchParams({
        hours: '24',
        threshold: String(Math.max(0.05, filters.minNet || 0.25)),
        minScore: String(filters.minScore || 0),
        cooldownMin: '10',
      });
      const r = await fetch(`/api/optimize?${qs}`, { cache: 'no-store' });
      setOpt((await r.json()) as OptResult);
    } catch {
      setOpt({ hours: 24, samples: 0, message: 'ошибка сети', best: [], current: null });
    } finally {
      setOptBusy(false);
    }
  };

  const runBacktest = async () => {
    setBtBusy(true);
    try {
      const qs = new URLSearchParams({
        threshold: String(Math.max(0.05, filters.minNet || 0.25)),
        minScore: String(filters.minScore || 0),
        hours: '24',
      });
      const r = await fetch(`/api/backtest?${qs}`, { cache: 'no-store' });
      const j = (await r.json()) as BtResult & { error?: string };
      if (j.error) {
        setBt({ hours: 0, signals: 0, decided: 0, winRate: null, avgNet: 0, samples: 0, message: j.error });
      } else {
        setBt(j);
      }
    } catch {
      setBt({ hours: 0, signals: 0, decided: 0, winRate: null, avgNet: 0, samples: 0, message: 'ошибка сети' });
    } finally {
      setBtBusy(false);
    }
  };

  const toggleEx = (id: ExchangeId) => {
    const has = filters.exchanges.includes(id);
    setFilters({ exchanges: has ? filters.exchanges.filter((x) => x !== id) : [...filters.exchanges, id] });
  };

  const numInput = (
    key: keyof Filters,
    label: string,
    step: string,
    w = 'w-[72px]',
    suffix = ''
  ) => (
    <label className="flex items-center gap-1.5">
      <span className="text-zinc-500">{label}</span>
      <Input
        type="number"
        step={step}
        value={filters[key] as number}
        onChange={(e) => setFilters({ [key]: parseFloat(e.target.value) || 0 } as Partial<Filters>)}
        className={`h-7 ${w} bg-zinc-900 px-2 text-xs tabular-nums`}
      />
      {suffix && <span className="text-zinc-600">{suffix}</span>}
    </label>
  );

  return (
    <div className="space-y-2 border-b border-zinc-800 bg-zinc-950/60 px-3 py-2 sm:px-5">
      {/* строка 1: поиск + числовые фильтры */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <Input
          placeholder="Поиск монеты…"
          value={filters.search}
          onChange={(e) => setFilters({ search: e.target.value })}
          className="h-7 w-40 bg-zinc-900 text-xs"
        />
        {/* Универсум — серверный отбор монет, а не фильтр строк: «топ по обороту» физически
            не содержит неликвида (нижняя граница выдачи ~$21M за сутки). */}
        <label className="flex items-center gap-1.5" title="Какие монеты вообще сканируются. Неликвид — полоса оборота $0.3–20M за 24ч">
          <span className="text-zinc-500">универсум</span>
          <select
            value={filters.universe || 'all'}
            onChange={(e) => setFilters({ universe: e.target.value as 'all' | 'illiquid' })}
            className={`h-7 rounded border bg-zinc-900 px-1.5 text-xs ${
              filters.universe === 'illiquid' ? 'border-amber-500/50 text-amber-400' : 'border-zinc-700 text-zinc-300'
            }`}
          >
            <option value="all">топ по обороту</option>
            <option value="illiquid">💧 неликвид $0.3–20M</option>
          </select>
        </label>
        {numInput('minTurnoverM', 'оборот ≥', '1', 'w-[68px]', 'M$')}
        {numInput('minSpread', 'спред ≥', '0.05', 'w-[68px]', '%')}
        {numInput('minNet', 'нетто ≥', '0.05', 'w-[68px]', '%')}
        {numInput('minScore', 'скор ≥', '5', 'w-[58px]')}
        {numInput('minCoverage', 'бирж ≥', '1', 'w-[52px]')}
        {numInput('minZ', 'z ≥', '0.5', 'w-[52px]')}
        {numInput('minBasis', 'базис ≥', '0.1', 'w-[56px]', '%')}
        {numInput('minFundingSpread', 'фандΔ ≥', '0.005', 'w-[60px]', '%')}
        {numInput('minWhale', 'киты ≥', '100', 'w-[62px]', 'K$')}
        {numInput('minLiq', 'ликв ≥', '50', 'w-[58px]', 'K$')}
        {numInput('minBreakout', 'пробой ≥', '10', 'w-[58px]')}
        <label className="flex items-center gap-1.5" title="Только пилы: низкая эффективность хода, стопы снимают с обеих сторон. Пробои здесь чаще ложные">
          <Switch checked={filters.onlyErsh} onCheckedChange={(v) => setFilters({ onlyErsh: v })} className="scale-90" />
          <span className="text-zinc-500">〰 ёрш</span>
        </label>
        <label className="flex items-center gap-1.5" title="Только раздача/набор: поток и открытый интерес расходятся с движением цены">
          <Switch checked={filters.onlyDist} onCheckedChange={(v) => setFilters({ onlyDist: v })} className="scale-90" />
          <span className="text-zinc-500">📦 раздача</span>
        </label>
        <label className="flex items-center gap-1.5">
          <Switch
            checked={filters.onlyWatchlist}
            onCheckedChange={(v) => setFilters({ onlyWatchlist: v })}
            className="scale-90"
          />
          <span className="text-zinc-500">★ watchlist</span>
        </label>
        <span className="ml-auto tabular-nums text-zinc-600">
          {shown}/{total}
        </span>
      </div>

      {/* строка 2: биржи + пресеты + экспорт */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <div className="flex items-center gap-1">
          <span className="mr-1 text-zinc-500">биржи:</span>
          {EXCHANGES.map((e) => {
            const active = filters.exchanges.includes(e.id);
            return (
              <button
                key={e.id}
                onClick={() => toggleEx(e.id)}
                className={`rounded-md border px-2 py-0.5 transition ${
                  active ? 'font-semibold' : 'border-zinc-800 text-zinc-500 hover:border-zinc-700'
                }`}
                style={active ? { borderColor: e.color, color: e.color, backgroundColor: `${e.color}14` } : undefined}
              >
                {e.name}
              </button>
            );
          })}
          {filters.exchanges.length > 0 && (
            <button onClick={() => setFilters({ exchanges: [] })} className="ml-1 text-zinc-500 hover:text-zinc-300">
              сброс
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) applyPreset(e.target.value);
            }}
            className="h-7 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-300"
            title="Загрузить пресет"
          >
            <option value="">пресеты…</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          {presets.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) deletePreset(e.target.value);
              }}
              className="h-7 rounded-md border border-zinc-800 bg-zinc-900 px-1 text-xs text-zinc-600"
              title="Удалить пресет"
            >
              <option value="">удалить…</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <Input
            placeholder="имя пресета"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            className="h-7 w-28 bg-zinc-900 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-zinc-800 px-2 text-xs"
            onClick={() => {
              const name = presetName.trim() || `пресет ${presets.length + 1}`;
              savePreset(name);
              setPresetName('');
            }}
          >
            ↳ сохранить
          </Button>
          <Button size="sm" variant="outline" className="h-7 border-zinc-800 px-2 text-xs" onClick={exportPresets}>
            ⭳ JSON
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-zinc-800 px-2 text-xs"
            onClick={() => fileRef.current?.click()}
          >
            ⭱ JSON
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importPresets(f);
              e.target.value = '';
            }}
          />
          <Button size="sm" variant="outline" className="h-7 border-zinc-800 px-2 text-xs" onClick={onExportCsv}>
            ⭳ CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-violet-500/40 px-2 text-xs text-violet-400"
            onClick={runBacktest}
            disabled={btBusy}
            title="Проиграть текущие фильтры (нетто ≥ и скор ≥) по истории сканов за 24ч"
          >
            {btBusy ? '…' : '🧪 тест'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-amber-500/40 px-2 text-xs text-amber-400"
            onClick={runOptimizer}
            disabled={optBusy}
            title="Перебрать сетку порогов по истории за 24ч с эмуляцией TP/SL — найти настройки с лучшим матожиданием"
          >
            {optBusy ? '…' : '⚙ оптимизатор'}
          </Button>
        </div>
      </div>

      {bt && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-violet-500/30 bg-violet-500/5 px-3 py-1.5 text-[11px] text-zinc-400">
          {bt.message ? (
            <span className="text-rose-400">🧪 {bt.message}</span>
          ) : (
            <>
              <span className="font-semibold text-violet-400">🧪 бэктест настроек за {bt.hours}ч:</span>
              <span>сигналов <b className="tabular-nums text-zinc-200">{bt.signals}</b></span>
              <span>оценено <b className="tabular-nums text-zinc-200">{bt.decided}</b></span>
              <span>
                сошлось за 30м{' '}
                <b className={`tabular-nums ${bt.winRate != null && bt.winRate >= 0.6 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {bt.winRate != null ? `${Math.round(bt.winRate * 100)}%` : '—'}
                </b>
              </span>
              <span>средний разрыв <b className="tabular-nums text-zinc-200">{bt.avgNet}%</b></span>
              {bt.signals === 0 && <span className="text-zinc-600">попробуй ослабить нетто ≥</span>}
            </>
          )}
        </div>
      )}

      {opt && (
        <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-zinc-400">
          {opt.message ? (
            <span className="text-amber-400">⚙ {opt.message}</span>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3">
                <span className="font-semibold text-amber-400">⚙ оптимизатор за {opt.hours}ч ({opt.samples} сканов):</span>
                <span className="text-zinc-600">сетка нетто × скор × кулдаун с эмуляцией TP/SL; ranked по матожиданию × √сделок</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-[11px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-zinc-600">
                      <th className="py-1 pr-2 font-medium">нетто ≥</th>
                      <th className="py-1 pr-2 font-medium">скор ≥</th>
                      <th className="py-1 pr-2 font-medium">кулдаун</th>
                      <th className="py-1 pr-2 text-right font-medium">сделок</th>
                      <th className="py-1 pr-2 text-right font-medium">win-rate</th>
                      <th className="py-1 pr-2 text-right font-medium">ср. сделка</th>
                      <th className="py-1 pr-2 text-right font-medium">сумма P&L</th>
                      <th className="py-1 pr-2 text-right font-medium">макс. просадка</th>
                      <th className="py-1 pr-2 text-right font-medium">сделок/сут</th>
                      <th className="py-1 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {opt.best.map((c, i) => (
                      <tr key={`${c.threshold}-${c.minScore}-${c.cooldownMin}`} className={opt.current && c.threshold === opt.current.threshold && c.minScore === opt.current.minScore && c.cooldownMin === opt.current.cooldownMin ? 'bg-violet-500/10' : ''}>
                        <td className="py-1 pr-2 font-mono tabular-nums text-zinc-200">{c.threshold.toFixed(2)}%</td>
                        <td className="py-1 pr-2 font-mono tabular-nums text-zinc-200">{c.minScore}</td>
                        <td className="py-1 pr-2 font-mono tabular-nums text-zinc-400">{c.cooldownMin}м</td>
                        <td className="py-1 pr-2 text-right font-mono tabular-nums text-zinc-400">{c.decided}</td>
                        <td className={`py-1 pr-2 text-right font-mono tabular-nums ${c.winRate != null && c.winRate >= 0.6 ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {c.winRate != null ? `${Math.round(c.winRate * 100)}%` : '—'}
                        </td>
                        <td className={`py-1 pr-2 text-right font-mono tabular-nums ${(c.avgPnl ?? 0) > 0 ? 'text-emerald-400' : (c.avgPnl ?? 0) < 0 ? 'text-rose-400' : 'text-zinc-500'}`}>
                          {c.avgPnl != null ? `${c.avgPnl >= 0 ? '+' : ''}${c.avgPnl.toFixed(3)}%` : '—'}
                        </td>
                        <td className={`py-1 pr-2 text-right font-mono tabular-nums ${c.totalPnl > 0 ? 'text-emerald-400' : c.totalPnl < 0 ? 'text-rose-400' : 'text-zinc-500'}`}>
                          {c.totalPnl >= 0 ? '+' : ''}{c.totalPnl.toFixed(2)}%
                        </td>
                        <td className="py-1 pr-2 text-right font-mono tabular-nums text-zinc-500">-{c.maxDdPct.toFixed(2)}</td>
                        <td className="py-1 pr-2 text-right font-mono tabular-nums text-zinc-500">{c.tradesPerDay}</td>
                        <td className="py-1 text-right">
                          <button
                            className="rounded border border-amber-500/40 px-1.5 py-0.5 text-amber-400 hover:bg-amber-500/10"
                            title="Применить к фильтрам"
                            onClick={() => setFilters({ minNet: c.threshold, minScore: c.minScore })}
                          >
                            применить
                          </button>
                          {i === 0 && <span className="ml-1 text-[10px] text-emerald-400">лучший</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Покрытие моделью издержек — первым, до любых чисел выше: таблица
                  порогов читается как рекомендация, а рекомендация, выведенная из
                  результата без главной издержки, зовёт в заведомо убыточную сделку. */}
              {(() => {
                const rows = [...opt.best, ...(opt.current ? [opt.current] : [])];
                const dec = rows.reduce((a, c) => a + c.decided, 0);
                const ns = rows.reduce((a, c) => a + (c.noSlip ?? 0), 0);
                if (!dec || !ns) return null;
                const full = ns >= dec;
                return (
                  <div className={full ? 'text-amber-500/90' : 'text-amber-500/70'}>
                    ⚠ {full ? 'все' : `${Math.round((ns / dec) * 100)}%`} сделок в таблице посчитаны только по
                    комиссиям: слипейдж на момент сигнала в снимках не записан. Круг со стаканом стоит порядка 1%
                    против 0.18% комиссий — матожидание выше завышено, и порядок комбинаций может измениться,
                    когда наберутся снимки со слипейджем.
                  </div>
                );
              })()}
              {opt.current && (
                <div className="text-zinc-600">
                  твои текущие настройки (строка с подсветкой): матожидание {opt.current.avgPnl != null ? `${opt.current.avgPnl >= 0 ? '+' : ''}${opt.current.avgPnl.toFixed(3)}%` : '—'} на сделку,
                  {opt.best[0] && opt.current.avgPnl != null && opt.best[0].avgPnl != null && opt.best[0].avgPnl > opt.current.avgPnl
                    ? ' оптимизатор нашёл лучше — примени одним кликом'
                    : ' пока лучший найденный результат' }
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

