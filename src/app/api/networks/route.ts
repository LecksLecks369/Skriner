import { NextRequest, NextResponse } from 'next/server';
import { fetchJsonLike } from '@/lib/screener/networks';

export const dynamic = 'force-dynamic';

/** Сети вывода монеты по данным OKX + Bitget (публичные endpoints) */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') || '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) {
    return NextResponse.json({ error: 'bad symbol' }, { status: 400 });
  }
  const base = symbol.replace(/USDT$/, '') || symbol;
  const data = await fetchJsonLike(base);
  return NextResponse.json({ symbol: base, ...data });
}

