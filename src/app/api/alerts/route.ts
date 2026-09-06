import { NextRequest } from 'next/server';
import { getScan } from '@/lib/screener/scan';
import type { CoinRow } from '@/lib/screener/types';

export const dynamic = 'force-dynamic';

interface StreamInit {
  thresholdPct: number;
  minScore: number;
  refExchange: string;
}

/** SSE-стрим алертов: |нетто-спред| >= порога либо скор >= порога скора */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const init: StreamInit = {
    thresholdPct: Math.max(0.05, parseFloat(sp.get('threshold') || '0.3') || 0.3),
    minScore: Math.max(0, parseFloat(sp.get('minScore') || '0') || 0),
    refExchange: sp.get('ref') || 'auto',
  };

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      let lastSent = new Map<string, number>(); // symbol -> ts последнего алерта (cooldown 90с)
      let robotSent = new Map<string, number>(); // отдельный кулдаун паттерна «робот вошёл» — 10 мин
      let running = true;

      const tick = async () => {
        while (running && !closed) {
          try {
            const resp = await getScan(80, init.refExchange as ExchangeIdOrAuto);
            const now = Date.now();
            const alerts: Array<Record<string, unknown>> = [];
            for (const row of resp.rows as CoinRow[]) {
              const spread = row.netSpreadPct;
              const isSpread = spread != null && spread >= init.thresholdPct;
              const isScore = init.minScore > 0 && row.score >= init.minScore;
              if (!isSpread && !isScore) continue;
              const last = lastSent.get(row.symbol) || 0;
              if (now - last < 90_000) continue; // серверный cooldown
              // рост разрыва — пробиваем cooldown
              const grew = spread != null && row.spreadSpark && row.spreadSpark.length > 2 &&
                spread >= (row.spreadSpark[row.spreadSpark.length - 3] || 0) * 1.3;
              if (!grew) lastSent.set(row.symbol, now);
              alerts.push({
                symbol: row.symbol,
                spreadPct: spread,
                zScore: row.zScore,
                score: row.score,
                ageMin: row.spreadAgeMin,
                coverage: row.coverage,
                hi: row.bestBid?.exchange,
                lo: row.bestAsk?.exchange,
                price: row.price,
                ts: now,
              });
            }
            if (alerts.length) send('alert', { alerts, ts: now });

            // Паттерн «🤖 робот вошёл в неликвид»: алго-скор ≥55 + неликвид ≥50 + спред
            const robotAlerts: Array<Record<string, unknown>> = [];
            for (const row of resp.rows as CoinRow[]) {
              const d = row.deep;
              if (!d?.pattern?.robotIlliquid) continue;
              const last = robotSent.get(row.symbol) || 0;
              if (now - last < 10 * 60_000) continue;
              robotSent.set(row.symbol, now);
              robotAlerts.push({
                symbol: row.symbol,
                algoScore: d.algoScore,
                illiqScore: d.illiqScore,
                netSpreadPct: row.netSpreadPct,
                slip25kPct: d.slip25kPct,
                maxPosUsd: d.maxPosUsd,
                entryEx: d.entryEx,
                exitEx: d.exitEx,
                reasons: d.pattern.reasons.slice(0, 4),
                price: row.price,
                ts: now,
              });
            }
            if (robotAlerts.length) send('robot', { alerts: robotAlerts, ts: now });

            send('ping', { ts: now, statuses: resp.statuses });
          } catch {
            send('ping', { ts: Date.now(), error: 'scan-failed' });
          }
          await new Promise((r) => setTimeout(r, 20_000));
        }
      };

      req.signal.addEventListener('abort', () => {
        running = false;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });

      send('hello', { threshold: init.thresholdPct, minScore: init.minScore });
      void tick();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

type ExchangeIdOrAuto = 'bybit' | 'bingx' | 'okx' | 'bitget' | 'mexc' | 'ourbit' | 'auto';

