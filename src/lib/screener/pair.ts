import { EXCHANGES, type CoinRow, type ExchangeId } from './types';

const FEE = Object.fromEntries(EXCHANGES.map((e) => [e.id, e.takerFee])) as Record<ExchangeId, number>;

/**
 * Текущий нетто-спред именно для пары бирж сделки: покупка на buyEx, продажа на sellEx.
 * row.netSpreadPct считается по лучшим bid/ask монеты и может относиться к другой паре бирж,
 * поэтому для P&L и TP/SL открытой позиции нужен спред её собственных ног.
 */
export function netSpreadForPair(row: CoinRow, buyEx: ExchangeId, sellEx: ExchangeId): number | null {
  const buy = row.exchanges.find((e) => e.exchange === buyEx)?.price;
  const sell = row.exchanges.find((e) => e.exchange === sellEx)?.price;
  if (!buy || !sell || buy <= 0) return null;
  const gross = ((sell - buy) / buy) * 100;
  return gross - (FEE[buyEx] + FEE[sellEx]) * 100;
}
