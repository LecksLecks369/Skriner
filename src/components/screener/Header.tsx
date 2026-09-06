'use client';

import { EXCHANGES, type ExchangeId, type ScanResponse } from '@/lib/screener/types';
import type { Settings } from './useScreener';
import { NotifySettings } from './NotifySettings';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';

function StatusDot({ ok, stale }: { ok: boolean; stale: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        !ok ? 'bg-zinc-600' : stale ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
      }`}
    />
  );
}

export function Header({
  scan,
  settings,
  setSettings,
  lastUpdate,
  paused,
  setPaused,
  refresh,
}: {
  scan: ScanResponse | null;
  settings: Settings;
  setSettings: (s: Partial<Settings>) => void;
  lastUpdate: number;
  paused: boolean;
  setPaused: (v: boolean) => void;
  refresh: () => void;
}) {
  const ageStr = lastUpdate ? Math.max(0, Math.round((Date.now() - lastUpdate) / 1000)) : null;

  return (
    <header className="border-b border-zinc-800 bg-zinc-950/90 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/75">
      <div className="mx-auto max-w-[1800px] px-3 py-2.5 sm:px-5">
        {/* строка 1: логотип + статусы бирж + обновление */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-2">
            <h1 className="text-base font-bold tracking-tight text-zinc-50 sm:text-lg">
              MetaScreener<span className="text-emerald-400">×</span>6
            </h1>
            <span className="hidden text-[11px] text-zinc-500 md:inline">
              межбиржевые неэффективности · фьючерсы USDT
            </span>
          </div>

          {/* статусы бирж */}
          <div className="flex flex-wrap items-center gap-1.5">
            {EXCHANGES.map((e) => {
              const st = scan?.statuses.find((s) => s.exchange === e.id);
              return (
                <Badge
                  key={e.id}
                  variant="outline"
                  className="gap-1.5 border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-[11px] font-normal text-zinc-400"
                  title={st?.error || st?.note || `${st?.symbols ?? 0} символов`}
                >
                  <StatusDot ok={!!st?.ok} stale={!!st?.stale} />
                  <span style={{ color: st?.ok ? e.color : undefined }}>{e.name}</span>
                  {st?.ok && <span className="tabular-nums text-zinc-500">{st.symbols}</span>}
                </Badge>
              );
            })}
          </div>

          {/* рыночный пульс */}
          {scan?.market && (
            <div className="flex items-center gap-1.5">
              {scan.market.fng && (
                <Badge
                  variant="outline"
                  className="gap-1 px-2 py-0.5 text-[11px] font-normal"
                  title="Индекс страха и жадности (alternative.me)"
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{
                      backgroundColor:
                        scan.market.fng.value >= 60 ? '#34d399' : scan.market.fng.value >= 40 ? '#fbbf24' : '#f87171',
                    }}
                  />
                  <span className="text-zinc-400">Страх/жадность</span>
                  <span className="font-mono font-semibold tabular-nums text-zinc-200">{scan.market.fng.value}</span>
                  <span className="hidden text-zinc-500 sm:inline">{scan.market.fng.label}</span>
                </Badge>
              )}
              {scan.market.btcDominance != null && (
                <Badge variant="outline" className="px-2 py-0.5 text-[11px] font-normal text-zinc-400" title="Доминирование BTC (CoinGecko)">
                  BTC <span className="font-mono tabular-nums text-zinc-200">{scan.market.btcDominance.toFixed(1)}%</span>
                </Badge>
              )}
              {scan.market.mcapChange24h != null && (
                <Badge
                  variant="outline"
                  className={`px-2 py-0.5 text-[11px] font-normal ${scan.market.mcapChange24h >= 0 ? 'text-emerald-400/90' : 'text-rose-400/90'}`}
                  title="Изменение капитализации рынка за 24ч (CoinGecko)"
                >
                  кап 24ч <span className="font-mono tabular-nums">{scan.market.mcapChange24h >= 0 ? '+' : ''}{scan.market.mcapChange24h.toFixed(2)}%</span>
                </Badge>
              )}
            </div>
          )}

          <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
            <Link
              href="/liquidity"
              className="rounded-md border border-zinc-800 px-2 py-1 text-zinc-400 hover:bg-zinc-900"
              title="Раздел «Неликвид»: детектор входа робота + глубина стакана"
            >
              🧲 неликвид
            </Link>
            <Link
              href="/radar"
              className="rounded-md border border-zinc-800 px-2 py-1 text-zinc-400 hover:bg-zinc-900"
              title="Режим «Радар» для второго монитора"
            >
              📺 радар
            </Link>
            <NotifySettings settings={settings} setSettings={setSettings} />
            <span className="tabular-nums">
              {scan ? `обновлено ${ageStr}s назад` : 'загрузка…'}
              {scan?.cached ? ' · кэш' : ''}
            </span>
            <button
              onClick={() => setPaused(!paused)}
              className="rounded-md border border-zinc-800 px-2 py-1 hover:bg-zinc-900"
              title="Пауза автообновления"
            >
              {paused ? '▶ пуск' : '⏸ пауза'}
            </button>
            <button
              onClick={refresh}
              className="rounded-md border border-zinc-800 px-2 py-1 hover:bg-zinc-900"
              title="Обновить сейчас"
            >
              ⟳
            </button>
          </div>
        </div>

        {/* строка 2: настройки алертов */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-400">
          <label className="flex items-center gap-1.5">
            <span>порог спреда</span>
            <Input
              type="number"
              step="0.05"
              min="0.05"
              value={settings.thresholdPct}
              onChange={(ev) => setSettings({ thresholdPct: parseFloat(ev.target.value) || 0.3 })}
              className="h-7 w-20 bg-zinc-900 px-2 text-xs tabular-nums"
            />
            <span className="text-zinc-500">%</span>
          </label>

          <label className="flex items-center gap-1.5">
            <span>кулдаун</span>
            <Input
              type="number"
              step="1"
              min="1"
              value={settings.cooldownMin}
              onChange={(ev) => setSettings({ cooldownMin: parseInt(ev.target.value) || 5 })}
              className="h-7 w-16 bg-zinc-900 px-2 text-xs tabular-nums"
            />
            <span className="text-zinc-500">мин</span>
          </label>

          <label className="flex items-center gap-1.5">
            <span>эталон</span>
            <Select
              value={settings.refExchange}
              onValueChange={(v) => setSettings({ refExchange: v as ExchangeId | 'auto' })}
            >
              <SelectTrigger className="h-7 w-[110px] bg-zinc-900 px-2 text-xs [&>svg]:hidden">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-zinc-950 border-zinc-800">
                <SelectItem value="auto" className="text-xs">Авто (лидер цены)</SelectItem>
                {EXCHANGES.map((e) => (
                  <SelectItem key={e.id} value={e.id} className="text-xs">{e.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="flex items-center gap-1.5">
            <Switch checked={settings.soundOn} onCheckedChange={(v) => setSettings({ soundOn: v })} className="scale-90" />
            <span>звук</span>
          </label>

          <NotifToggle on={settings.notifOn} setOn={(v) => setSettings({ notifOn: v })} />

          <label className="flex items-center gap-1.5">
            <Switch checked={settings.alertScoreOn} onCheckedChange={(v) => setSettings({ alertScoreOn: v })} className="scale-90" />
            <span>алерт по скору ≥</span>
            <Input
              type="number"
              step="5"
              min="0"
              max="100"
              value={settings.minScoreAlert}
              onChange={(ev) => setSettings({ minScoreAlert: parseInt(ev.target.value) || 0 })}
              disabled={!settings.alertScoreOn}
              className="h-7 w-14 bg-zinc-900 px-2 text-xs tabular-nums disabled:opacity-40"
            />
          </label>
        </div>
      </div>
    </header>
  );
}

function NotifToggle({ on, setOn }: { on: boolean; setOn: (v: boolean) => void }) {
  const enable = async () => {
    if (on) {
      setOn(false);
      return;
    }
    if (!('Notification' in window)) {
      alert('Браузер не поддерживает уведомления');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      setOn(true);
      new Notification('MetaScreener', { body: 'Уведомления включены ✅' });
    }
  };
  return (
    <label className="flex items-center gap-1.5">
      <Switch checked={on} onCheckedChange={enable} className="scale-90" />
      <span>браузерные уведомления</span>
    </label>
  );
}

