/* Paper-трейдинг: хранилище виртуальных спред-сделок + серверный автопилот.

   Раньше сделки заводились только руками из карточки монеты, а TP/SL считались в браузере
   на вкладке «Бумажные» — стоило закрыть вкладку, и симулятор переставал существовать.
   Поэтому статистика была пустая, и проверить, зарабатывает ли скринер, было нечем.

   Теперь открытие и сопровождение живут на сервере и идут на каждом скане:
   - открываем только там, где известна глубина стакана обеих ног — сделка без слипейджа
     завышала бы P&L ровно на стоимость исполнения (порог входа см. ниже);
   - TP/SL считаем по спреду СОБСТВЕННЫХ ног сделки, а не по лучшей паре бирж монеты;
   - есть таймаут: разрыв, не сошедшийся за 6 часов, чаще структурный, чем арбитражный.

   Пороги TP/SL совпадают с теми, что были в UI, чтобы старые и новые сделки были сравнимы. */

import fs from 'fs';
import path from 'path';
import type { CoinRow, ExchangeId, PaperTrade } from './types';
import { netSpreadForPair } from './pair';
import { arbConvergeLevelPct, arbCostPct, arbFeesPct, arbPnlPct, arbSlLevelPct, arbTpTargetPct } from './costs';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'paper_trades.json');
const MAX_TRADES = 500;

/* ---------------- Параметры автопилота ---------------- */

/* Порог входа берётся по сырому нетто-спреду и совпадает с порогом журнала: те же кандидаты,
   что попадают в историю сигналов, попадают и в симулятор.

   Отбирать по исполнимому спреду (netExec = netSpread − слипейдж круга) не получается:
   на живом скане он равен нулю у ВСЕХ монет с известной книгой — лучший сырой спред ~0.33%
   против слипейджа круга 0.09–1.21%. С таким фильтром симулятор не открыл бы ни одной сделки
   и статистика осталась бы пустой навсегда.

   Поэтому вход — по сырому спреду, а стоимость исполнения честно вычитается при закрытии
   (слипейдж круга дважды: вход и выход). Если эджа нет, симулятор покажет это минусом
   в матожидании — это и есть ответ на вопрос «зарабатывает ли скринер», а не пустая таблица. */
const MIN_ENTRY_PCT = 0.25;
/** Больше стольких открытых позиций одновременно не держим */
const MAX_OPEN = 25;
/** Повторный вход по тому же символу не раньше этого срока */
const REENTRY_MS = 30 * 60_000;
/** Не сошёлся за это время — закрываем по текущему спреду */
const TIMEOUT_MS = 6 * 3600_000;
/** Размер позиции, на который считается слипейдж (совпадает с бюджетом deep-блока) */
const DEFAULT_SIZE_USD = 25_000;

/** Версия модели P&L. v2: издержки круга считаются целиком (комиссии обеих ног ДВАЖДЫ
    + проскальзывание входа и выхода), а «тейк» ставится по прибыли, а не по схлопыванию
    спреда. Сделки v1 при загрузке пересчитываются: у них комиссии не вычитались ни разу,
    и всякое схлопывание помечалось как 'tp' независимо от знака результата. */
export const PNL_MODEL_VERSION = 2;

/** Полные издержки круга сделки, % от номинала */
export function tradeCostPct(t: Pick<PaperTrade, 'buyEx' | 'sellEx' | 'slipRoundTripPct'>): number {
  return arbCostPct(t.buyEx, t.sellEx, t.slipRoundTripPct ?? null);
}

/** P&L, если закрыться прямо сейчас по нетто-спреду cur */
export function pnlIfClosed(t: Pick<PaperTrade, 'buyEx' | 'sellEx' | 'slipRoundTripPct' | 'netEntry'>, cur: number): number {
  return arbPnlPct(t.netEntry, cur, tradeCostPct(t));
}

/* ---------------- Хранилище ---------------- */

interface PaperGlobal {
  __screenerPaper: { trades: PaperTrade[]; loaded: boolean };
}
const g = globalThis as unknown as PaperGlobal;
if (!g.__screenerPaper) g.__screenerPaper = { trades: [], loaded: false };
const store = g.__screenerPaper;

export function loadPaper(): PaperTrade[] {
  if (store.loaded) return store.trades;
  store.loaded = true;
  try {
    if (fs.existsSync(FILE)) {
      store.trades = JSON.parse(fs.readFileSync(FILE, 'utf8')) as PaperTrade[];
    }
  } catch {
    store.trades = [];
  }
  if (migrateClosed(store.trades)) savePaper();
  return store.trades;
}

/* Пересчёт закрытых сделок старой модели. Все входные величины сохранены в самой сделке
   (netEntry, netExit, пара бирж, слипейдж), поэтому результат восстанавливается точно —
   переоценивать по рынку ничего не нужно. Заодно чинится причина закрытия: 'tp' на сделке,
   которая после издержек в минусе, — это схлопывание разрыва, а не тейк. */
function migrateClosed(trades: PaperTrade[]): boolean {
  let changed = 0;
  for (const t of trades) {
    if (t.status !== 'closed' || t.netExit == null) continue;
    if (t.pnlModelV === PNL_MODEL_VERSION) continue;
    applyPnl(t, t.netExit);
    if (t.closeReason === 'tp') {
      const tp = arbTpTargetPct(t.netEntry, t.costPct ?? 0);
      if (tp == null || (t.pnlPct ?? 0) < tp) t.closeReason = 'converged';
    }
    changed++;
  }
  if (changed) {
    console.warn(`[paper] сделок пересчитано по модели издержек v${PNL_MODEL_VERSION}: ${changed}`);
  }
  return changed > 0;
}

/** Записать в сделку издержки и P&L выхода по нетто-спреду netExit */
function applyPnl(tr: PaperTrade, netExit: number) {
  const cost = tradeCostPct(tr);
  const gross = tr.netEntry - netExit;
  tr.netExit = netExit;
  tr.feesPct = Number(arbFeesPct(tr.buyEx, tr.sellEx).toFixed(4));
  tr.costPct = Number(cost.toFixed(4));
  tr.pnlGrossPct = Number(gross.toFixed(4));
  tr.pnlPct = Number((gross - cost).toFixed(4));
  tr.pnlModelV = PNL_MODEL_VERSION;
}

export function savePaper() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store.trades, null, 0));
  } catch {
    /* диск недоступен — держим в памяти */
  }
}

export function setPaperTrades(next: PaperTrade[]) {
  store.trades = next;
  savePaper();
}

export interface OpenInput {
  symbol: string;
  buyEx: ExchangeId;
  sellEx: ExchangeId;
  pBuy: number;
  pSell: number;
  netEntry: number;
  score?: number;
  sizeUsd?: number;
  slipRoundTripPct?: number | null;
  auto?: boolean;
}

export function openPaperTrade(input: OpenInput): PaperTrade {
  const trades = loadPaper();
  const slipRt =
    typeof input.slipRoundTripPct === 'number' && Number.isFinite(input.slipRoundTripPct) && input.slipRoundTripPct >= 0
      ? Number(input.slipRoundTripPct.toFixed(4))
      : null;
  const trade: PaperTrade = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    symbol: input.symbol,
    buyEx: input.buyEx,
    sellEx: input.sellEx,
    pBuy: input.pBuy,
    pSell: input.pSell,
    netEntry: Number(input.netEntry.toFixed(4)),
    score: input.score ?? 0,
    status: 'open',
    sizeUsd: typeof input.sizeUsd === 'number' && Number.isFinite(input.sizeUsd) ? input.sizeUsd : undefined,
    slipRoundTripPct: slipRt ?? undefined,
    slipModeled: slipRt != null,
    auto: input.auto || undefined,
  };
  trades.push(trade);
  if (trades.length > MAX_TRADES) store.trades = trades.slice(-MAX_TRADES);
  savePaper();
  return trade;
}

/**
 * Закрыть сделку по нетто-спреду выхода.
 * P&L = (нетто-спред входа − нетто-спред выхода) − издержки круга, где издержки =
 * комиссии пары бирж ДВАЖДЫ (вход и выход) + проскальзывание обеих ног дважды.
 *
 * Комиссии обязаны вычитаться отдельной строкой: netEntry и netExit уже посчитаны
 * за вычетом комиссий одного пересечения, поэтому в их разности комиссии сокращаются
 * и круг выходил бесплатным. Без стакана (slipModeled=false) учтены только комиссии,
 * и результат завышен ровно на неучтённое проскальзывание.
 */
export function closePaperTrade(id: string, netExit: number, reason: PaperTrade['closeReason']): PaperTrade | null {
  const trades = loadPaper();
  const tr = trades.find((x) => x.id === id && x.status === 'open');
  if (!tr) return null;
  tr.status = 'closed';
  tr.closedTs = Date.now();
  applyPnl(tr, netExit);
  tr.closeReason = reason || 'manual';
  savePaper();
  return tr;
}

/* ---------------- Автопилот ---------------- */

export interface AutoPaperResult {
  opened: number;
  closed: { tp: number; sl: number; timeout: number; converged: number };
}

/** Сопровождение и набор бумажных сделок по свежему скану. Вызывается из scan. */
export function autoPaper(rows: CoinRow[]): AutoPaperResult {
  const trades = loadPaper();
  const byS = new Map(rows.map((r) => [r.symbol, r]));
  const now = Date.now();
  const res: AutoPaperResult = { opened: 0, closed: { tp: 0, sl: 0, timeout: 0, converged: 0 } };

  /* 1) Сопровождение открытых.
     Тейк ставится по ПРИБЫЛИ после издержек, а не по схлопыванию спреда: раньше выход
     срабатывал на сжатии разрыва до трети, что при круге дороже самого разрыва давало
     закрытие с меткой 'tp' и отрицательным P&L. Схлопывание без прибыли теперь честно
     помечается 'converged' — эджа больше нет, держать позицию незачем, но это не тейк. */
  for (const t of trades.filter((x) => x.status === 'open')) {
    const row = byS.get(t.symbol);
    const cur = row ? netSpreadForPair(row, t.buyEx, t.sellEx) : null;
    if (cur == null) {
      // монета выпала из скана: закрываем только по таймауту, иначе ждём её возвращения
      if (now - t.ts >= TIMEOUT_MS && closePaperTrade(t.id, t.netEntry, 'timeout')) res.closed.timeout++;
      continue;
    }
    const tp = arbTpTargetPct(t.netEntry, tradeCostPct(t));
    const pnlNow = pnlIfClosed(t, cur);
    if (tp != null && pnlNow >= tp) {
      if (closePaperTrade(t.id, cur, 'tp')) res.closed.tp++;
    } else if (cur >= arbSlLevelPct(t.netEntry)) {
      if (closePaperTrade(t.id, cur, 'sl')) res.closed.sl++;
    } else if (cur <= arbConvergeLevelPct(t.netEntry)) {
      if (closePaperTrade(t.id, cur, 'converged')) res.closed.converged++;
    } else if (now - t.ts >= TIMEOUT_MS) {
      if (closePaperTrade(t.id, cur, 'timeout')) res.closed.timeout++;
    }
  }

  // 2) Набор новых
  const openNow = trades.filter((x) => x.status === 'open');
  if (openNow.length >= MAX_OPEN) return res;
  const openSyms = new Set(openNow.map((x) => x.symbol));
  const lastBySym = new Map<string, number>();
  for (const t of trades) {
    const prev = lastBySym.get(t.symbol) ?? 0;
    if (t.ts > prev) lastBySym.set(t.symbol, t.ts);
  }

  const candidates = rows
    .filter((r) => {
      if (openSyms.has(r.symbol)) return false; // одна позиция на символ
      if (now - (lastBySym.get(r.symbol) ?? 0) < REENTRY_MS) return false;
      if (!r.bestAsk || !r.bestBid) return false;
      if (r.bestAsk.exchange === r.bestBid.exchange) return false; // спред нужен межбиржевой
      if (r.netSpreadPct == null) return false;
      // без книги слипейдж неизвестен: такая сделка завысила бы P&L на стоимость исполнения
      if (r.deep?.slipRoundTripPct == null) return false;
      return r.netSpreadPct >= MIN_ENTRY_PCT;
    })
    .sort((a, b) => (b.netSpreadPct ?? 0) - (a.netSpreadPct ?? 0))
    .slice(0, MAX_OPEN - openNow.length);

  for (const r of candidates) {
    openPaperTrade({
      symbol: r.symbol,
      buyEx: r.bestAsk!.exchange,
      sellEx: r.bestBid!.exchange,
      pBuy: r.bestAsk!.price,
      pSell: r.bestBid!.price,
      netEntry: r.netSpreadPct!,
      score: r.score,
      sizeUsd: r.deep?.slipBudgetUsd ?? DEFAULT_SIZE_USD,
      slipRoundTripPct: r.deep?.slipRoundTripPct ?? null,
      auto: true,
    });
    res.opened++;
  }
  return res;
}
