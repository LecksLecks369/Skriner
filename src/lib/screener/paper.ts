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

/** TP: спред сжался до трети от входа (но не строже 0.05%) */
function tpLevel(netEntry: number): number {
  return Math.max(0.05, netEntry * 0.35);
}
/** SL: разрыв разошёлся ещё на 0.25 п.п. против позиции */
function slLevel(netEntry: number): number {
  return netEntry + 0.25;
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
  return store.trades;
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

/** Закрыть сделку по нетто-спреду выхода. P&L = (вход − выход) минус слипейдж входа и выхода. */
export function closePaperTrade(id: string, netExit: number, reason: PaperTrade['closeReason']): PaperTrade | null {
  const trades = loadPaper();
  const tr = trades.find((x) => x.id === id && x.status === 'open');
  if (!tr) return null;
  tr.status = 'closed';
  tr.closedTs = Date.now();
  tr.netExit = netExit;
  const gross = tr.netEntry - netExit;
  tr.pnlGrossPct = Number(gross.toFixed(4));
  /* Симулятор обязан «проедать стакан»: круг пересекает обе книги дважды — на входе
     (покупка+продажа) и на выходе (обратные ноги). slipRoundTripPct — стоимость одного
     такого пересечения, поэтому вычитаем её дважды. Без стакана на входе (slipModeled=false)
     P&L остаётся валовым и завышенным ровно на величину неучтённого проскальзывания. */
  const slipCost = tr.slipRoundTripPct != null ? tr.slipRoundTripPct * 2 : 0;
  tr.pnlPct = Number((gross - slipCost).toFixed(4));
  tr.closeReason = reason || 'manual';
  savePaper();
  return tr;
}

/* ---------------- Автопилот ---------------- */

export interface AutoPaperResult {
  opened: number;
  closed: { tp: number; sl: number; timeout: number };
}

/** Сопровождение и набор бумажных сделок по свежему скану. Вызывается из scan. */
export function autoPaper(rows: CoinRow[]): AutoPaperResult {
  const trades = loadPaper();
  const byS = new Map(rows.map((r) => [r.symbol, r]));
  const now = Date.now();
  const res: AutoPaperResult = { opened: 0, closed: { tp: 0, sl: 0, timeout: 0 } };

  // 1) Сопровождение открытых
  for (const t of trades.filter((x) => x.status === 'open')) {
    const row = byS.get(t.symbol);
    const cur = row ? netSpreadForPair(row, t.buyEx, t.sellEx) : null;
    if (cur == null) {
      // монета выпала из скана: закрываем только по таймауту, иначе ждём её возвращения
      if (now - t.ts >= TIMEOUT_MS && closePaperTrade(t.id, t.netEntry, 'timeout')) res.closed.timeout++;
      continue;
    }
    if (cur <= tpLevel(t.netEntry)) {
      if (closePaperTrade(t.id, cur, 'tp')) res.closed.tp++;
    } else if (cur >= slLevel(t.netEntry)) {
      if (closePaperTrade(t.id, cur, 'sl')) res.closed.sl++;
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
