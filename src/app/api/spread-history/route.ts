import { NextRequest, NextResponse } from 'next/server';
import { seriesStore } from '@/lib/screener/store';

export const dynamic = 'force-dynamic';

/** Мини-чарт спреда: серия [ts, pct] по символу */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') || '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) {
    return NextResponse.json({ error: 'bad symbol' }, { status: 400 });
  }
  const hist = seriesStore.getSpreadHistory(symbol);
  return NextResponse.json({ symbol, points: hist.slice(-240) });
}

