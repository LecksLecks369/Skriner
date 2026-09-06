'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import type { Settings } from './useScreener';

/* Диалог: конструктор правил алертов (И/ИЛИ) + внешние оповещения (webhook / Telegram). */

export function NotifySettings({
  settings,
  setSettings,
}: {
  settings: Settings;
  setSettings: (s: Partial<Settings>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);

  const num = (key: keyof Settings, label: string, step = '0.05', w = 'w-20') => (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-zinc-400">{label}</span>
      <Input
        type="number"
        step={step}
        value={settings[key] as number}
        onChange={(e) => setSettings({ [key]: parseFloat(e.target.value) || 0 } as Partial<Settings>)}
        className={`h-7 ${w} bg-zinc-900 px-2 font-mono text-xs tabular-nums`}
      />
    </label>
  );

  const testNotify = async () => {
    setTesting(true);
    try {
      const text = 'MetaScreener: тестовое оповещение ✅';
      let okWebhook = !settings.notifyWebhook;
      let okTg = !settings.notifyTgToken || !settings.notifyTgChat;
      if (settings.notifyWebhook) {
        await fetch(settings.notifyWebhook, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, source: 'metascreener', test: true }),
        }).catch(() => undefined);
        okWebhook = true; // no-cors не даёт прочитать ответ — считаем отправленным
      }
      if (settings.notifyTgToken && settings.notifyTgChat) {
        const r = await fetch('/api/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: settings.notifyTgToken, chatId: settings.notifyTgChat, text }),
        });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        okTg = !!j.ok;
        if (!okTg) toast({ title: 'Telegram: ошибка', description: j.error || 'проверь token/chatId', duration: 6000 });
      }
      toast({
        title: okWebhook && okTg ? 'Тест отправлен' : 'Частично отправлено',
        description: [
          settings.notifyWebhook ? 'webhook: отправлен' : '',
          settings.notifyTgToken && settings.notifyTgChat ? `telegram: ${okTg ? 'доставлено' : 'ошибка'}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        duration: 6000,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-900" title="Конструктор алертов и внешние оповещения">
          🔔 правила
        </button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-200 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Алерты: правила и оповещения</DialogTitle>
        </DialogHeader>

        {/* конструктор правил */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-300">Конструктор правил</span>
            <Switch checked={settings.rulesOn} onCheckedChange={(v) => setSettings({ rulesOn: v })} className="scale-90" />
          </div>
          <div className={`space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 ${settings.rulesOn ? '' : 'opacity-50'}`}>
            <label className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">режим</span>
              <Select value={settings.ruleMode} onValueChange={(v) => setSettings({ ruleMode: v as 'and' | 'or' })}>
                <SelectTrigger className="h-7 w-32 bg-zinc-900 px-2 text-xs [&>svg]:hidden">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-950">
                  <SelectItem value="and" className="text-xs">И — все условия</SelectItem>
                  <SelectItem value="or" className="text-xs">ИЛИ — любое из</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {num('rNet', 'нетто-спред ≥, %')}
            {num('rZ', 'z-score ≥', '0.5')}
            {num('rScore', 'скор ≥', '5')}
            {num('rBasis', 'спот-базис ≥, %')}
            {num('rFds', 'фандинг-разброс ≥, %', '0.01')}
            {num('rWhale', 'киты ≥, тыс. $', '50')}
            {num('rLiq', 'ликвидации ≥, тыс. $/15м', '50')}
            <p className="text-[10px] leading-relaxed text-zinc-600">
              Условия с нулевым значением не участвуют. Проверка идёт на каждом скане (45с), кулдаун — общий с алертами.
            </p>
          </div>
        </section>

        {/* внешние оповещения */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-300">Внешние оповещения</span>
            <Switch checked={settings.notifyOn} onCheckedChange={(v) => setSettings({ notifyOn: v })} className="scale-90" />
          </div>
          <div className={`space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 ${settings.notifyOn ? '' : 'opacity-50'}`}>
            <label className="block text-xs">
              <span className="text-zinc-400">Webhook URL (JSON POST)</span>
              <Input
                placeholder="https://your-bot.example/hook"
                value={settings.notifyWebhook}
                onChange={(e) => setSettings({ notifyWebhook: e.target.value })}
                className="mt-1 h-7 bg-zinc-900 text-xs"
              />
            </label>
            <label className="block text-xs">
              <span className="text-zinc-400">Telegram bot token</span>
              <Input
                placeholder="123456:ABC-DEF…"
                value={settings.notifyTgToken}
                onChange={(e) => setSettings({ notifyTgToken: e.target.value })}
                className="mt-1 h-7 bg-zinc-900 text-xs"
                type="password"
              />
            </label>
            <label className="block text-xs">
              <span className="text-zinc-400">Telegram chat ID</span>
              <Input
                placeholder="-1001234567890"
                value={settings.notifyTgChat}
                onChange={(e) => setSettings({ notifyTgChat: e.target.value })}
                className="mt-1 h-7 bg-zinc-900 text-xs"
              />
            </label>
            <p className="text-[10px] leading-relaxed text-zinc-600">
              Всё хранится только в твоём браузере (localStorage). Бот должен иметь чат в контактах и право писать.
            </p>
            <Button size="sm" variant="outline" className="h-7 w-full border-zinc-800 text-xs" disabled={testing} onClick={testNotify}>
              {testing ? 'отправляю…' : 'Отправить тест'}
            </Button>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

