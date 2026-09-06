import { NextRequest, NextResponse } from 'next/server';
import { getScan } from '@/lib/screener/scan';
import type { ExchangeId } from '@/lib/screener/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const top = Math.min(200, Math.max(10, parseInt(sp.get('top') || '80', 10) || 80));
    const refRaw = (sp.get('ref') || 'auto') as ExchangeId | 'auto';
    const ref = ['bybit', 'bingx', 'okx', 'bitget', 'mexc', 'ourbit'].includes(refRaw) ? (refRaw as ExchangeId) : 'auto';
    const resp = await getScan(top, ref);
    return NextResponse.json(resp);
  } catch (e) {
    console.error('[scan] failed:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'scan failed' }, { status: 500 });
  }
}

