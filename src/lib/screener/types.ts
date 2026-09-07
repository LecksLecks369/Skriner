export type ExchangeId = 'bybit' | 'bingx' | 'okx' | 'bitget' | 'mexc' | 'ourbit';

export interface ExchangeInfo {
  id: ExchangeId;
  name: string;
  takerFee: number; // доля, напр. 0.00055 = 0.055%
  color: string;
}

export const EXCHANGES: ExchangeInfo[] = [
  { id: 'bybit', name: 'Bybit', takerFee: 0.00055, color: '#f7a600' },
  { id: 'bingx', name: 'BingX', takerFee: 0.0005, color: '#2f6bff' },
  { id: 'okx', name: 'OKX', takerFee: 0.0005, color: '#8cc63f' },
  { id: 'bitget', name: 'Bitget', takerFee: 0.0006, color: '#00f0ff' },
  { id: 'mexc', name: 'MEXC', takerFee: 0.0002, color: '#00b897' },
  { id: 'ourbit', name: 'Ourbit', takerFee: 0.00055, color: '#9d7bff' },
];

export interface RawTicker {
  symbol: string; // нормализованный: BTCUSDT
  nativeSymbol: string; // как на бирже
  price: number; // цена последней сделки — НЕ котировка, торговать по ней нельзя
  bid: number | null; // лучший bid стакана (по нему продают)
  ask: number | null; // лучший ask стакана (по нему покупают)
  turnoverUsd: number; // 24h объём в USDT
  fundingRate?: number | null;
  oi?: number | null; // open interest в монетах
  oiUsd?: number | null;
  nextFundingTs?: number | null; // время следующего фандинга (Bybit/BingX)
}

export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // объём в монетах
  qv: number; // объём в USDT
}

export interface ExchangeFetchResult {
  exchange: ExchangeId;
  ok: boolean;
  error?: string;
  tickers: RawTicker[];
  fetchedAt: number;
  lagMs?: number;
}

export interface KlinesResult {
  exchange: ExchangeId;
  symbol: string;
  candles: Candle[];
  intervalMin: number;
}

export interface SweepSignal {
  dir: 'up' | 'down'; // up = снятие ликвидности сверху (лонг-стопы), down = снизу
  ageMin: number;
  wickAtr: number; // тень / ATR
  volMult: number; // объём / средний
}

export interface ExchangeRow {
  exchange: ExchangeId;
  price: number; // последняя сделка (для отображения)
  bid: number | null; // лучший bid — по нему продают
  ask: number | null; // лучший ask — по нему покупают
  fundingRate: number | null; // ставка как её публикует биржа, за свой период
  fundingIntervalMin: number | null; // период начисления, минут (240 = 4ч, 480 = 8ч)
  oiUsd: number | null;
  dOiPct5m: number | null;
  dOiPct15m: number | null;
  dOiPct1h: number | null;
  natrPct: number | null;
  volZ: number | null;
  sweep: SweepSignal | null;
  cvdTaker: number | null; // BingX: (takerBuy - takerSell)/total, -1..1
}

export interface CoinRow {
  symbol: string; // BTCUSDT
  bestBid?: { exchange: ExchangeId; price: number };
  bestAsk?: { exchange: ExchangeId; price: number };
  price: number; // медианная цена
  turnoverUsd: number; // максимальный оборот среди бирж
  coverage: number; // сколько бирж имеют монету
  exchanges: ExchangeRow[];
  crossSpreadPct: number | null; // (max-min)/mid * 100
  refSpreadPct: number | null; // спред vs эталонной биржи
  netSpreadPct: number | null; // кросс-спред минус taker-комиссии обеих сторон
  netExecPct: number | null; // исполнимый спред: netSpreadPct минус проскальзывание обеих ног (только там, где есть deep)
  quoteBased: boolean; // спред построен по bid/ask минимум двух бирж; false = котировок не хватило, спреда нет
  zScore: number | null; // аномальность спреда против своей истории
  spreadAgeMin: number | null; // сколько минут спред ≥ порога
  score: number; // 0..100
  scoreParts: Record<string, number>;
  fundingAbs: number | null; // максимум |ставки|, приведённой к 8 часам
  fundingNormalized: boolean; // известен ли период начисления; false = ставка взята как есть
  oiUsdMax: number | null;
  dOiPct15m: number | null;
  dOiPct1h: number | null;
  natrPctMax: number | null;
  volZMax: number | null;
  sweepFresh: SweepSignal | null;
  cvdTaker: number | null;
  spark: number[]; // серия цен для спарклайна
  spreadSpark: number[]; // серия кросс-спреда %
  tradingViewSymbol: string;

  /* -------- Premium v3 -------- */
  spotBasisPct: number | null; // перп vs спот, % (макс |базис| по биржам)
  spotBasis: { ex: ExchangeId; perp: number; spot: number; pct: number } | null;
  fundingSpreadPct: number | null; // разброс фандинга между биржами (max-min), % за период
  fundingNextMin: number | null; // минут до ближайшего фандинга
  fundingNextFrom: ExchangeId | null;
  cvdProxy: number | null; // агрессия по свечам за 15м: (объём растущих - падающих)/общий, -1..1
  btcCorr: number | null; // корреляция минутных доходностей с BTC за 60м
  whaleNetUsd: number | null; // нетто китовых сделок Bybit (>$50k) за 5м
  whaleCount: number | null;
  rep: { n: number; winRate: number | null } | null; // репутация сигналов монеты по журналу

  /* -------- Неликвид + алго-детектор -------- */
  illiqProxy: number | null; // 0-100 дешёвая оценка неликвидности (оборот+Амихуд+спред, без стакана)
  algoProxy: number | null; // 0-100 всплеск активности (объём+ΔOI+свип, без ленты)
  deep?: LiquidityDeep | null; // полный блок стакан+лента для топ-40 по скору

  /* -------- Ликвидации + розница (торговый блок, топ-40 по скору) -------- */
  liq5mUsd: number | null; // ликвидации за 5 минут, USD (OKX)
  liq15mUsd: number | null; // ликвидации за 15 минут, USD
  liqLongUsd: number | null; // лонгов ликвидировано за 15м (сигнал на отскок вверх)
  liqShortUsd: number | null; // шортов ликвидировано за 15м (сигнал на откло вниз)
  lsrLongPct: number | null; // % аккаунтов розницы в лонгах (Bybit account-ratio, фолбэк OKX)
  lsrRatio: number | null; // лонг/шорт ratio
  lsrEx: ExchangeId | null; // источник LSR
}

/* ---------- Неликвид: глубина стакана одной биржи ---------- */
export interface ExDepth {
  depth10Usd: number; // сумма заявок в ±0.1% от mid, USD
  depth25Usd: number; // ±0.25%
  depth50Usd: number; // ±0.5%
  bookSpreadPct: number; // нативный спред стакана
  slip10kPct: number | null; // проскальзывание рыночного ордера $10k (худшая сторона), %
  slip25kPct: number | null;
  slip50kPct: number | null;
  maxPosUsd: number; // макс размер с слипейджем ≤0.3% (худшая сторона), USD
  maxPosTruncated: boolean; // книга кончилась раньше порога: значение — нижняя оценка, не рынок
}

/* ---------- Неликвид: статистика ленты сделок ---------- */
export interface TapeStats {
  windowSec: number; // сколько секунд покрывает лента
  trades: number;
  tradesPerMin: number;
  aggression: number; // (тейкер-покупки - тейкер-продажи)/всего, -1..1
  clipRatio: number; // доля объёма в кластере одноразмерных клипов, 0..1
  clipCount: number; // сделок в кластере
  clipUsd: number; // средний размер клипа, USD
  gapCv: number | null; // CV интервалов между клипами (<0.4 = механическая регулярность)
  bigNetUsd: number; // нетто сделок >$100k (buy-sell), USD
}

/* ---------- Неликвид: полный deep-блок монеты ---------- */
export interface LiquidityDeep {
  ts: number;
  perEx: Partial<Record<ExchangeId, ExDepth>>; // стакан по биржам входа/выхода
  entryEx: ExchangeId | null; // где купить дешевле (bestAsk)
  exitEx: ExchangeId | null; // где продать дороже (bestBid)
  slip25kPct: number | null; // худший слипейдж $25k среди entry/exit
  slipRoundTripPct: number | null; // слипейдж обеих ног круга: вход + выход, %
  slipBudgetUsd: number | null; // на каком объёме измерен slipRoundTripPct ($25k, иначе $10k)
  maxPosUsd: number | null; // минимальный безопасный размер среди entry/exit
  maxPosTruncated: boolean; // хотя бы одна книга кончилась раньше порога — значение занижено
  tape: TapeStats | null;
  tapeEx: ExchangeId | null;
  amihudPct: number | null; // % движения цены на $1M рыночного ордера (по 1м свечам)
  algoScore: number; // 0-100: клипы + регулярность + агрессия + всплеск
  illiqScore: number; // 0-100: глубина + слипейдж + Амихуд + оборот (больше = неликвиднее)
  pattern: { robotIlliquid: boolean; reasons: string[] } | null;
}

export interface ExchangeStatus {
  exchange: ExchangeId;
  ok: boolean;
  error?: string;
  symbols: number;
  fetchedAt: number;
  ageSec: number;
  stale: boolean;
  note?: string;
}

export interface JournalSummary {
  signals24h: number;
  conv30m: number | null; // доля спредов, сошедшихся за 30 мин
  total: number;
}

export interface MarketPulse {
  ts: number;
  fng: { value: number; label: string } | null; // индекс страха и жадности
  btcDominance: number | null;
  mcapChange24h: number | null; // изменение капитализации рынка за 24ч, %
}

export interface PaperTrade {
  id: string;
  ts: number;
  symbol: string;
  buyEx: ExchangeId;
  sellEx: ExchangeId;
  pBuy: number;
  pSell: number;
  netEntry: number; // нетто-спред на входе, %
  score: number;
  status: 'open' | 'closed';
  closedTs?: number;
  netExit?: number; // нетто-спред на выходе, %
  pnlGrossPct?: number; // netEntry - netExit, без учёта проскальзывания
  pnlPct?: number; // итоговый P&L: gross минус проскальзывание входа и выхода, % от номинала
  closeReason?: 'tp' | 'sl' | 'manual';
  /* Учёт глубины стакана: без него симулятор считает спред полностью исполнимым любым размером */
  sizeUsd?: number; // размер позиции, на который оценивался слипейдж (по умолчанию $25k)
  slipRoundTripPct?: number; // слипейдж обеих ног на входе (из deep-блока), %
  slipModeled?: boolean; // false = стакан был недоступен, P&L завышен на величину слипейджа
}

export interface ScanResponse {
  ts: number;
  cached: boolean;
  top: number;
  klinedSymbols: number;
  rows: CoinRow[];
  statuses: ExchangeStatus[];
  errors: Record<string, string>;
  refExchange: ExchangeId | 'auto';
  alertThresholdPct: number;
  journal: JournalSummary;
  market: MarketPulse | null;
}

