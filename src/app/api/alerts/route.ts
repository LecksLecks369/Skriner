import { NextRequest } from 'next/server';
import { BREAKOUT_ALERT, getScan } from '@/lib/screener/scan';
import type { CoinRow } from '@/lib/screener/types';
import { numParam } from '@/lib/screener/params';
import { COOLDOWN_MS, SPREAD_ALERT_MIN_Z, isPatternMuted } from '@/lib/screener/patterns';

/* Авто-отключение: тип сигнала, у которого весь доверительный интервал матожидания лежит
   ниже нуля, в алерты не идёт — он доказанно не окупает издержки. Отключение молчаливым
   быть не должно: список выключенных уезжает в каждом ping, иначе пропавшие алерты
   неотличимы от сломанного стрима. Запись в историю паттернов при этом продолжается,
   так что тип включится сам, когда плохие исходы выйдут из окна оценки. */

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
    thresholdPct: numParam(sp, 'threshold', 0.3, 0.05),
    minScore: numParam(sp, 'minScore', 0, 0),
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

      /* Кулдауны берутся из COOLDOWN_MS — той же таблицы, по которой сигнал
         пишется в историю. Своих чисел здесь быть не может: карточка каждого типа
         подписана alertScope, и 'same' — это утверждение, что популяция алертов и
         популяция записей совпадают. Пока числа стояли отдельно (90с/10/15/20 мин
         против 30 у записи), утверждение было ложным для robot, breakout и
         distribution, а win-rate на карточке относился к более редкой выборке. */
      let lastSent = new Map<string, number>(); // symbol -> ts последнего спред-алерта
      let robotSent = new Map<string, number>();
      const breakoutSent = new Map<string, number>();
      const distSent = new Map<string, number>();
      let running = true;

      const tick = async () => {
        while (running && !closed) {
          try {
            const resp = await getScan(80, init.refExchange as ExchangeIdOrAuto);
            const now = Date.now();
            const muted = {
              spread: isPatternMuted('spread'),
              robot: isPatternMuted('robot'),
              breakout: isPatternMuted('breakout'),
              distribution: isPatternMuted('distribution'),
              /* Ёрш едет пометкой внутри пробоя, но это такое же утверждение о рынке,
                 как и остальные, — и оно тоже должно сниматься, когда доказано, что
                 попадания не превышают базовой частоты. */
              chop: isPatternMuted('chop'),
            };
            const alerts: Array<Record<string, unknown>> = [];
            /* Сколько кандидатов не доехало до алерта из-за неизвестного стакана:
               молчание по этой причине неотличимо от «разрывов нет», поэтому счётчик
               уезжает в ping. */
            let noBookCount = 0;
            /* Кандидатов, снятых вторым затвором: разрыв исполним, но для этого
               символа он не выходит за его собственную норму. */
            let noBaselineCount = 0;
            for (const row of resp.rows as CoinRow[]) {
              const spread = row.netSpreadPct;
              /* Триггер по ИСПОЛНИМОМУ спреду, а не по сырому. Сырой не вычитает
                 слипейдж круга, и на живом скане круг дороже разрыва почти всегда:
                 медиана slipRoundTripPct 0.519% — то есть 1.04% на круг — против
                 медианы нетто-разрыва −0.06%. Алерт по сырому зовёт в сделку,
                 которую вторая модель этой же системы оценивает в −2.34% на сделку
                 (148 закрытых бумажных сделок). Стакан неизвестен — вердикта нет,
                 и это не повод выдать оптимистичный.

                 netExecPct больше не обрезается снизу нулём: обрезка делала 32
                 строки из 33 равными ровно 0.000 и прятала расхождение с лестницей
                 размеров, которая всегда считала круг как два пересечения книг. */
              const exec = row.netExecPct;
              const bookKnown = exec != null;
              const spreadCandidate = spread != null && spread >= init.thresholdPct;
              if (!muted.spread && spreadCandidate && !bookKnown) noBookCount++;
              /* Второй затвор — необычность разрыва для САМОГО символа. Разрыв
                 0.3% на монете, где 0.3% это норма, — базовая линия, а не
                 расхождение; в замере группа без истории (z отсутствует) —
                 единственная с отрицательным матожиданием. Порог общий с тем, по
                 которому «История» разбивает win-rate. */
              const zOk = row.zScore != null && row.zScore >= SPREAD_ALERT_MIN_Z;
              if (!muted.spread && spreadCandidate && bookKnown && exec > 0 && !zOk) noBaselineCount++;
              // выключенный спред снимает только спред-триггер: алерт по скору — другой сигнал
              const isSpread = !muted.spread && spreadCandidate && bookKnown && exec > 0 && zOk;
              const isScore = init.minScore > 0 && row.score >= init.minScore;
              if (!isSpread && !isScore) continue;
              const last = lastSent.get(row.symbol) || 0;
              /* Кулдаун спреда — тот же, что и у записи в историю. Прежняя ветка
                 «разрыв вырос — пробиваем кулдаун» снята: повторная сработка внутри
                 горизонта оценки это продолжение открытого сигнала, а не новое
                 наблюдение, и именно на затянувшихся разрывах (то есть на
                 контрпримерах к тезису паттерна) она давала больше всего копий. */
              if (now - last < COOLDOWN_MS.spread) continue;
              lastSent.set(row.symbol, now);
              alerts.push({
                symbol: row.symbol,
                spreadPct: spread,
                // исполнимый спред и слипейдж круга — то, по чему принято решение
                netExecPct: row.netExecPct,
                slipRoundTripPct: row.deep?.slipRoundTripPct ?? null,
                slipBudgetUsd: row.deep?.slipBudgetUsd ?? null,
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

            /* Паттерн «🤖 робот вошёл в неликвид». Условие живёт в liquidity.ts
               (ROBOT_ALGO_MIN / ROBOT_ILLIQ_MIN + непустая лента); межбиржевого
               разрыва в воротах нет с тех пор, как замер показал, что спред и
               алго-активность на полосе неликвида не совпадают. Числа здесь не
               дублируются: подпись, набранная отдельно от константы, расходится
               с ней молча и ровно тогда, когда порог двигают. */
            const robotAlerts: Array<Record<string, unknown>> = [];
            for (const row of resp.rows as CoinRow[]) {
              if (muted.robot) break;
              const d = row.deep;
              if (!d?.pattern?.robotIlliquid) continue;
              const last = robotSent.get(row.symbol) || 0;
              if (now - last < COOLDOWN_MS.robot) continue;
              robotSent.set(row.symbol, now);
              robotAlerts.push({
                symbol: row.symbol,
                algoScore: d.algoScore,
                illiqScore: d.illiqScore,
                netSpreadPct: row.netSpreadPct,
                /* Исполнимый спред рядом с сырым. Робот — предупреждение о структуре
                   книги, а не предложение арбитража, но алерт печатает маршрут
                   (вход → выход, max-позиция) и нетто-спред, и без исполнимого рядом
                   это читается как сделка. Замер на живом скане: у сработавшего
                   символа нетто было −0.16% при слипейдже $25k в 1.07% — маршрут,
                   убыточный ещё до издержек круга. null = стакан не измерен. */
                netExecPct: row.netExecPct,
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

            /* Сетапы движения: пробой — только ДО выхода за уровень (иначе это уже
               не предупреждение, а констатация), раздача/набор — только когда поток
               расходится с ценой. Ёрш отдельным алертом не шлём — он приезжает пометкой
               внутри пробоя: его смысл в том, чтобы НЕ входить.

               Пороги ЗДЕСЬ те же, по которым сигнал пишется в историю паттернов, поэтому
               win-rate пробоя и раздачи во вкладке «История» относится ровно к этим
               алертам. На спред это НЕ распространяется: порог его записи фиксирован
               (RECORD_THR.spreadNetPct), а init.thresholdPct задаёт пользователь, так что
               популяции расходятся. Вкладка «История» подписывает это у каждой карточки
               полем alertScope — утверждать совпадение по всем типам сразу нельзя. */
            const setupAlerts: Array<Record<string, unknown>> = [];
            for (const row of resp.rows as CoinRow[]) {
              const b = row.breakout;
              if (b && !muted.breakout && b.ready && b.score >= BREAKOUT_ALERT) {
                if (now - (breakoutSent.get(row.symbol) || 0) >= COOLDOWN_MS.breakout) {
                  breakoutSent.set(row.symbol, now);
                  setupAlerts.push({
                    kind: 'breakout',
                    symbol: row.symbol,
                    dir: b.dir,
                    score: b.score,
                    level: b.level,
                    distAtr: b.distAtr,
                    distPct: b.distPct,
                    squeeze: b.squeeze,
                    touches: b.touches,
                    chopScore: row.chop?.score ?? null,
                    isErsh: !muted.chop && (row.chop?.isErsh ?? false),
                    reasons: b.reasons.slice(0, 4),
                    price: row.price,
                    ts: now,
                  });
                }
              }
              const d = row.dist;
              if (d && d.dir && !muted.distribution) {
                if (now - (distSent.get(row.symbol) || 0) >= COOLDOWN_MS.distribution) {
                  distSent.set(row.symbol, now);
                  setupAlerts.push({
                    kind: 'distribution',
                    symbol: row.symbol,
                    dir: d.dir,
                    distKind: d.kind,
                    score: d.score,
                    movePct: d.movePct,
                    reasons: d.reasons.slice(0, 4),
                    price: row.price,
                    ts: now,
                  });
                }
              }
            }
            if (setupAlerts.length) send('setup', { alerts: setupAlerts, ts: now });

            send('ping', {
              ts: now,
              statuses: resp.statuses,
              // какие типы сигналов сейчас выключены по отрицательному эджу
              muted: Object.entries(muted).filter(([, v]) => v).map(([k]) => k),
              /* Стадии, которые скан не успел: пустой поток алертов при
                 пропущенном стакане — это «не измерено», а не «нет разрывов». */
              skippedStages: resp.skippedStages ?? [],
              spreadNoBook: noBookCount,
              spreadNoBaseline: noBaselineCount,
              spreadMinZ: SPREAD_ALERT_MIN_Z,
            });
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

