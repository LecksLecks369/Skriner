'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EXCHANGES, type CoinRow } from '@/lib/screener/types';
import { useScreener } from '@/components/screener/useScreener';
import { Header } from '@/components/screener/Header';
import { Filters } from '@/components/screener/Filters';
import { TableView, filterAndSort } from '@/components/screener/TableView';
import { CoinModal } from '@/components/screener/CoinModal';
import { AlertCenter } from '@/components/screener/AlertCenter';
import { JournalPanel } from '@/components/screener/JournalPanel';
import { PatternHistory } from '@/components/screener/PatternHistory';
import { PaperPanel } from '@/components/screener/PaperPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fmtPct, fmtPrice, fmtTurnover } from '@/components/screener/format';

function exportCsv(rows: CoinRow[]) {
  const head = [
    'symbol',
    'price',
    'score',
    'cross_spread_pct',
    'net_spread_pct',
    'z_score',
    'age_min',
    'coverage',
    'funding_abs',
    'd_oi_15m_pct',
    'oi_usd_max',
    'natr_pct',
    'turnover_usd',
    'algo_score',
    'illiq_score',
    'liq_15m_usd',
    'lsr_long_pct',
    'buy_on',
    'sell_on',
  ];
  const lines = rows.map((r) =>
    [
      r.symbol,
      r.price,
      r.score,
      r.crossSpreadPct?.toFixed(3) ?? '',
      r.netSpreadPct?.toFixed(3) ?? '',
      r.zScore?.toFixed(2) ?? '',
      r.spreadAgeMin ?? '',
      r.coverage,
      r.fundingAbs?.toFixed(5) ?? '',
      r.dOiPct15m?.toFixed(3) ?? '',
      r.oiUsdMax?.toFixed(0) ?? '',
      r.natrPctMax?.toFixed(3) ?? '',
      r.turnoverUsd.toFixed(0),
      String(r.deep?.algoScore ?? r.algoProxy ?? ''),
      String(r.deep?.illiqScore ?? r.illiqProxy ?? ''),
      r.liq15mUsd?.toFixed(0) ?? '',
      r.lsrLongPct?.toFixed(1) ?? '',
      r.bestAsk?.exchange ?? '',
      r.bestBid?.exchange ?? '',
    ].join(',')
  );
  const blob = new Blob([head.join(',') + '\n' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `screener-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const router = useRouter();
  const s = useScreener();
  // храним символ + снимок строки: сама строка берётся из свежего скана, чтобы модалка
  // не замерзала на данных момента открытия; снимок — фолбэк, если монета вышла из топа
  const [opened, setOpened] = useState<{ symbol: string; snapshot: CoinRow } | null>(null);
  const navIdx = useRef(0);
  const threshold = s.settings.thresholdPct;
  const open = opened ? s.scan?.rows.find((r) => r.symbol === opened.symbol) ?? opened.snapshot : null;

  const filtered = useMemo(() => {
    if (!s.scan) return [];
    return filterAndSort(s.scan.rows, s.filters, s.watchlist, threshold);
  }, [s.scan, s.filters, s.watchlist, threshold]);

  const filteredRef = useRef<CoinRow[]>(filtered);
  useEffect(() => {
    filteredRef.current = filtered;
  }, [filtered]);

  /* горячие клавиши: / — поиск, j/k — навигация по строкам, r — радар */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === '/') {
        e.preventDefault();
        (document.querySelector('input[placeholder^="Поиск"]') as HTMLInputElement | null)?.focus();
      } else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
        // router.push вместо window.location: полная перезагрузка сбрасывала
        // открытый SSE-стрим алертов и прогретое состояние скана
        router.push('/radar');
      } else if (e.key === 'l' && !e.metaKey && !e.ctrlKey) {
        router.push('/liquidity');
      } else if (e.key === 'j') {
        e.preventDefault();
        const rows = filteredRef.current;
        if (rows.length) {
          navIdx.current = Math.min(navIdx.current + 1, rows.length - 1);
          setOpened({ symbol: rows[navIdx.current].symbol, snapshot: rows[navIdx.current] });
        }
      } else if (e.key === 'k') {
        e.preventDefault();
        const rows = filteredRef.current;
        if (rows.length) {
          navIdx.current = Math.max(navIdx.current - 1, 0);
          setOpened({ symbol: rows[navIdx.current].symbol, snapshot: rows[navIdx.current] });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const stats = useMemo(() => {
    const rows = s.scan?.rows || [];
    const alerting = rows.filter((r) => r.netSpreadPct != null && r.netSpreadPct >= threshold);
    const live = s.scan?.statuses.filter((x) => x.ok).length || 0;
    return { total: rows.length, alerting: alerting.length, live };
  }, [s.scan, threshold]);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-200">
      <Header
        scan={s.scan}
        settings={s.settings}
        setSettings={s.setSettings}
        lastUpdate={s.lastUpdate}
        paused={s.paused}
        setPaused={s.setPaused}
        refresh={s.refresh}
      />

      <main className="mx-auto w-full max-w-[1800px] flex-1">
        {/* сводка */}
        <div className="flex flex-wrap items-center gap-3 px-3 pt-3 text-xs sm:px-5">
          <span className="rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1">
            монет: <b className="tabular-nums text-zinc-100">{stats.total}</b>
          </span>
          <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-400">
            сигналов ≥ {threshold}%: <b className="tabular-nums">{stats.alerting}</b>
          </span>
          <span className="rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-zinc-400">
            бирж активно: <b className="tabular-nums">{stats.live}/{EXCHANGES.length}</b>
          </span>
          <span className="hidden text-zinc-600 sm:inline">
            скан-цикл 45с · горячие клавиши: / поиск · j/k навигация · r радар · l неликвид
          </span>
        </div>

        <div className="mt-3">
          <Filters
            filters={s.filters}
            setFilters={s.setFilters}
            presets={s.presets}
            savePreset={s.savePreset}
            applyPreset={s.applyPreset}
            deletePreset={s.deletePreset}
            exportPresets={s.exportPresets}
            importPresets={s.importPresets}
            onExportCsv={() => exportCsv(filtered)}
            total={s.scan?.rows.length || 0}
            shown={filtered.length}
          />
        </div>

        <Tabs defaultValue="screener">
          <div className="px-3 pt-3 sm:px-5">
            <TabsList className="bg-zinc-900">
              <TabsTrigger value="screener" className="text-xs">Скринер</TabsTrigger>
              <TabsTrigger value="patterns" className="text-xs">📈 История</TabsTrigger>
              <TabsTrigger value="journal" className="text-xs">Журнал сигналов</TabsTrigger>
              <TabsTrigger value="paper" className="text-xs">📝 Бумажные</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="screener" className="mt-2">
            {s.loading ? (
              <div className="flex h-64 items-center justify-center text-sm text-zinc-600">
                Первый скан: агрегирую 6 бирж, клайны и OI…
              </div>
            ) : (
              <TableView
                rows={filtered}
                filters={s.filters}
                setFilters={s.setFilters}
                watchlist={s.watchlist}
                toggleWatch={s.toggleWatch}
                threshold={threshold}
                onOpen={(r) => setOpened({ symbol: r.symbol, snapshot: r })}
              />
            )}
          </TabsContent>
          <TabsContent value="patterns" className="mt-2">
            <PatternHistory />
          </TabsContent>
          <TabsContent value="journal" className="mt-2">
            <JournalPanel />
          </TabsContent>
          <TabsContent value="paper" className="mt-2">
            <PaperPanel scan={s.scan} />
          </TabsContent>
        </Tabs>
      </main>

      <footer className="mt-auto border-t border-zinc-800 px-3 py-3 text-[10px] leading-relaxed text-zinc-600 sm:px-5">
        MetaScreener × 7 premium — публичные API Bybit · Binance · BingX · OKX · Bitget · MEXC · Ourbit; страх/жадность alternative.me;
        глобальные метрики CoinGecko. Не является инвестиционной рекомендацией. Нетто-спред учитывает taker-комиссии,
        но не вывод и проскальзывание. Настройки, watchlist, пресеты и ключи оповещений — в localStorage; журнал,
        снапшоты и paper-сделки — на сервере.
      </footer>

      <CoinModal key={open?.symbol || 'none'} row={open} threshold={threshold} onClose={() => setOpened(null)} />
      <AlertCenter settings={s.settings} paused={s.paused} scan={s.scan} />
    </div>
  );
}

