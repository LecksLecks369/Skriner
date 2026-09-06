import { NextRequest, NextResponse } from 'next/server';
import { getScan } from '@/lib/screener/scan';
import { symbolReputation } from '@/lib/screener/store';
import type { CoinRow } from '@/lib/screener/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/* ИИ-комментарий к сигналу: z-ai-web-dev-sdk, кэш 5 минут на монету. */

interface AiGlobal {
  __screenerAi: Map<string, { ts: number; text: string }>;
}
const g = globalThis as unknown as AiGlobal;
if (!g.__screenerAi) g.__screenerAi = new Map();
const aiCache = g.__screenerAi;

const SYSTEM =
  'Ты — опытный криптотрейдер-аналитик, специализация: межбиржевые неэффективности фьючерсов. ' +
  'Тебе дают метрики сигнала скринера. Ответь ПО-РУССКИ, 1-2 предложения, без воды и без приветствий: ' +
  'объясни, почему сигнал возник и в чём риск. Дай одну конкретную рекомендацию (торговать / пропустить / что ждать). ' +
  'Не выдумывай числа, которых нет в данных.';

function digest(row: CoinRow): string {
  const parts = Object.entries(row.scoreParts)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const ex = row.exchanges
    .map((x) => `${x.exchange}: цена ${x.price.toFixed(6)}, фандинг ${x.fundingRate != null ? (x.fundingRate * 100).toFixed(4) + '%' : '—'}`)
    .join('; ');
  return JSON.stringify({
    монета: row.symbol,
    нетто_спред_проц: row.netSpreadPct,
    кросс_спред_проц: row.crossSpreadPct,
    route: row.bestBid && row.bestAsk ? `купить ${row.bestAsk.exchange} → продать ${row.bestBid.exchange}` : null,
    z_score: row.zScore,
    возраст_мин: row.spreadAgeMin,
    покрытие_бирж: row.coverage,
    скор: row.score,
    компоненты_скора: parts,
    фандинг_разброс_проц: row.fundingSpreadPct,
    до_следующего_фандинга_мин: row.fundingNextMin,
    dOI_15м_проц: row.dOiPct15m,
    dOI_1ч_проц: row.dOiPct1h,
    NATR_проц: row.natrPctMax,
    z_объёма: row.volZMax,
    свип_ликвидации: row.sweepFresh,
    спот_базис_проц: row.spotBasisPct,
    киты_net_usd_5м: row.whaleNetUsd,
    корреляция_с_BTC: row.btcCorr,
    прокси_CVD: row.cvdProxy,
    репутация_монеты: row.rep,
    оборот_24ч_usd: row.turnoverUsd,
    биржи: ex,
  });
}

export async function POST(req: NextRequest) {
  try {
    const { symbol, force } = (await req.json()) as { symbol?: string; force?: boolean };
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });

    const cached = aiCache.get(symbol);
    if (cached && !force && Date.now() - cached.ts < 5 * 60_000) {
      return NextResponse.json({ comment: cached.text, cached: true });
    }

    const scan = await getScan(80, 'auto');
    const row = scan.rows.find((r) => r.symbol === symbol);
    if (!row) return NextResponse.json({ error: 'монета не в текущем скане' }, { status: 404 });

    const rep = symbolReputation();
    const ZAI = (await import('z-ai-web-dev-sdk')).default;
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            digest(row) +
            (rep[symbol] ? ` Общая статистика монеты по журналу: ${JSON.stringify(rep[symbol])}.` : ''),
        },
      ],
      thinking: { type: 'disabled' },
    });
    const text = completion.choices[0]?.message?.content?.trim() || '';
    if (!text) return NextResponse.json({ error: 'пустой ответ модели' }, { status: 502 });
    aiCache.set(symbol, { ts: Date.now(), text });
    if (aiCache.size > 300) {
      const cutoff = Date.now() - 30 * 60_000;
      for (const [k, v] of aiCache) if (v.ts < cutoff) aiCache.delete(k);
    }
    return NextResponse.json({ comment: text, cached: false });
  } catch (e) {
    console.error('[ai-comment]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'ai failed' }, { status: 500 });
  }
}

