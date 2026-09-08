'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExchangeId, ScanResponse } from '@/lib/screener/types';

export interface Filters {
  search: string;
  /* Какие монеты вообще попадают в скан. Это НЕ фильтр по уже полученным строкам:
     универсум задаётся на сервере полосой оборота, потому что «топ-80 по обороту»
     физически не содержит неликвида — нижняя граница выдачи была ~$21M за сутки. */
  universe: 'all' | 'illiquid';
  minTurnoverM: number; // млн USD
  minSpread: number; // % кросс-спред
  minNet: number; // % нетто-спред
  minScore: number;
  minCoverage: number;
  minZ: number; // z-score спреда ≥
  minBasis: number; // |спот×перпетуал базис| ≥ %
  minFundingSpread: number; // разброс фандинга между биржами ≥ %
  minWhale: number; // |китовые сделки| ≥ тыс. USD за 5м
  minLiq: number; // ликвидации за 15м ≥ тыс. USD (каскад)
  minBreakout: number; // готовность к пробою ≥ (0 = не фильтровать)
  onlyErsh: boolean; // только «ерши» — зоны ложных пробоев
  onlyDist: boolean; // только раздача/набор (контр-сигнал внутри пампа или дампа)
  exchanges: ExchangeId[]; // пусто = все
  onlyWatchlist: boolean;
  sortKey: string;
  sortDir: 'asc' | 'desc';
}

export interface Preset {
  name: string;
  filters: Filters;
  thresholdPct: number;
  minScoreAlert: number;
  cooldownMin: number;
  refExchange: ExchangeId | 'auto';
}

export interface Settings {
  thresholdPct: number;
  cooldownMin: number;
  refExchange: ExchangeId | 'auto';
  soundOn: boolean;
  notifOn: boolean;
  alertScoreOn: boolean;
  minScoreAlert: number;
  /* конструктор правил алертов (И/ИЛИ) */
  rulesOn: boolean;
  ruleMode: 'and' | 'or';
  rNet: number; // нетто-спред ≥ %
  rZ: number; // z-score ≥
  rScore: number; // скор ≥
  rBasis: number; // |базис| ≥ %
  rFds: number; // фандинг-разброс ≥ %
  rWhale: number; // киты ≥ тыс. USD
  rLiq: number; // ликвидации за 15м ≥ тыс. USD
  /* внешние оповещения */
  notifyOn: boolean;
  notifyWebhook: string;
  notifyTgToken: string;
  notifyTgChat: string;
}

const DEFAULT_FILTERS: Filters = {
  search: '',
  universe: 'all',
  minTurnoverM: 5,
  minSpread: 0,
  minNet: 0,
  minScore: 0,
  minCoverage: 1,
  minZ: 0,
  minBasis: 0,
  minFundingSpread: 0,
  minWhale: 0,
  minLiq: 0,
  minBreakout: 0,
  onlyErsh: false,
  onlyDist: false,
  exchanges: [],
  onlyWatchlist: false,
  sortKey: 'score',
  sortDir: 'desc',
};

const DEFAULT_SETTINGS: Settings = {
  thresholdPct: 0.3,
  cooldownMin: 5,
  refExchange: 'auto',
  soundOn: true,
  notifOn: false,
  alertScoreOn: false,
  minScoreAlert: 70,
  rulesOn: false,
  ruleMode: 'and',
  rNet: 0.3,
  rZ: 0,
  rScore: 0,
  rBasis: 0,
  rFds: 0,
  rWhale: 0,
  rLiq: 0,
  notifyOn: false,
  notifyWebhook: '',
  notifyTgToken: '',
  notifyTgChat: '',
};

/* Чтение из localStorage.
   Слияние с дефолтом нужно объектам настроек: у пользователя лежит вчерашняя форма, и
   новые поля должны прийти из def. Но объектный спред НЕЛЬЗЯ применять к массиву:
   `{ ...[], ...['BTCUSDT'] }` даёт `{0:'BTCUSDT'}` — объект, у которого нет ни includes,
   ни map, и первый же рендер таблицы падает с «watchlist.includes is not a function»,
   а экран остаётся пустым. Форму значения выбираем по типу дефолта. */
function loadLS<T>(key: string, def: T): T {
  if (typeof window === 'undefined') return def;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as T;
    if (Array.isArray(def)) return (Array.isArray(parsed) ? parsed : def) as T;
    if (def && typeof def === 'object' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...def, ...parsed };
    }
    return parsed == null ? def : parsed;
  } catch {
    return def;
  }
}
function saveLS(key: string, v: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export function useScreener() {
  const [filters, setFiltersState] = useState<Filters>(() => loadLS('ms_filters', DEFAULT_FILTERS));
  const [settings, setSettingsState] = useState<Settings>(() => loadLS('ms_settings', DEFAULT_SETTINGS));
  const [watchlist, setWatchlist] = useState<string[]>(() => loadLS<string[]>('ms_watchlist', []));
  const [presets, setPresets] = useState<Preset[]>(() => loadLS<Preset[]>('ms_presets', []));
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [paused, setPaused] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const setFilters = useCallback((f: Partial<Filters>) => {
    setFiltersState((prev) => {
      const next = { ...prev, ...f };
      /* Переход в неликвид с унаследованным порогом оборота дал бы пустую таблицу:
         полоса неликвида ($0.3–20M) целиком ниже привычного фильтра в 5M, и экран
         выглядел бы сломанным, а не отфильтрованным. */
      if (f.universe === 'illiquid' && prev.universe !== 'illiquid' && next.minTurnoverM > 0) next.minTurnoverM = 0;
      saveLS('ms_filters', next);
      return next;
    });
  }, []);

  const setSettings = useCallback((s: Partial<Settings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...s };
      saveLS('ms_settings', next);
      return next;
    });
  }, []);

  const toggleWatch = useCallback((symbol: string) => {
    setWatchlist((prev) => {
      const next = prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol];
      saveLS('ms_watchlist', next);
      return next;
    });
  }, []);

  const savePreset = useCallback(
    (name: string) => {
      setPresets((prev) => {
        const p: Preset = { name, filters, ...settingsRef.current };
        const next = [...prev.filter((x) => x.name !== name), p].slice(-20);
        saveLS('ms_presets', next);
        return next;
      });
    },
    [filters]
  );

  const applyPreset = useCallback((name: string) => {
    setPresets((prev) => {
      const p = prev.find((x) => x.name === name);
      if (p) {
        const { name: _n, filters: f, thresholdPct, minScoreAlert, cooldownMin, refExchange } = p;
        setFiltersState({ ...DEFAULT_FILTERS, ...f });
        saveLS('ms_filters', { ...DEFAULT_FILTERS, ...f });
        setSettingsState((s) => {
          const next = { ...s, thresholdPct, minScoreAlert, cooldownMin, refExchange };
          saveLS('ms_settings', next);
          return next;
        });
      }
      return prev;
    });
  }, []);

  const deletePreset = useCallback((name: string) => {
    setPresets((prev) => {
      const next = prev.filter((x) => x.name !== name);
      saveLS('ms_presets', next);
      return next;
    });
  }, []);

  const exportPresets = useCallback(() => {
    const blob = new Blob([JSON.stringify({ filters, settings, presets, watchlist }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `metascalp-presets-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filters, settings, presets, watchlist]);

  const importPresets = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const j = JSON.parse(String(reader.result)) as Partial<{ filters: Filters; settings: Settings; presets: Preset[]; watchlist: string[] }>;
        if (j.filters) {
          setFiltersState((p) => ({ ...p, ...j.filters }));
          saveLS('ms_filters', j.filters);
        }
        if (j.settings) {
          setSettingsState((p) => ({ ...p, ...j.settings }));
          saveLS('ms_settings', j.settings);
        }
        if (Array.isArray(j.presets)) {
          setPresets(j.presets.slice(0, 40));
          saveLS('ms_presets', j.presets.slice(0, 40));
        }
        if (Array.isArray(j.watchlist)) {
          setWatchlist(j.watchlist);
          saveLS('ms_watchlist', j.watchlist);
        }
      } catch {
        /* bad json */
      }
    };
    reader.readAsText(file);
  }, []);

  // polling /api/scan
  const fetchScan = useCallback(async () => {
    try {
      const qs = new URLSearchParams({
        top: '80',
        ref: settingsRef.current.refExchange,
        universe: filtersRef.current.universe || 'all',
      });
      const res = await fetch(`/api/scan?${qs}`, { cache: 'no-store' });
      if (res.ok) {
        const j = (await res.json()) as ScanResponse;
        setScan(j);
        setLastUpdate(Date.now());
      }
    } catch {
      /* сеть моргнула */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchScan();
    const iv = setInterval(() => {
      if (!paused && document.visibilityState !== 'hidden') void fetchScan();
    }, 30_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') void fetchScan();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
    };
    // universe в зависимостях: смена универсума — это другой набор монет, ждать 30с нельзя
  }, [fetchScan, paused, filters.universe]);

  return {
    filters,
    setFilters,
    settings,
    setSettings,
    watchlist,
    toggleWatch,
    presets,
    savePreset,
    applyPreset,
    deletePreset,
    exportPresets,
    importPresets,
    scan,
    loading,
    lastUpdate,
    paused,
    setPaused,
    refresh: fetchScan,
  };
}

