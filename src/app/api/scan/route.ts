import { NextRequest, NextResponse } from 'next/server';
import { getScan, UNIVERSE_ALL, UNIVERSE_ILLIQUID, type Universe } from '@/lib/screener/scan';
import type { ExchangeId } from '@/lib/screener/types';
import { numParam } from '@/lib/screener/params';

/** Полоса оборота: пресет `universe=illiquid|all` либо явные границы в USD */
function universeFrom(sp: URLSearchParams): Universe {
  const preset = sp.get('universe');
  const base = preset === 'illiquid' ? UNIVERSE_ILLIQUID : UNIVERSE_ALL;
  const min = sp.get('minTurnover');
  const max = sp.get('maxTurnover');
  const sampling = sp.get('sampling');
  return {
    minTurnoverUsd: min != null ? numParam(sp, 'minTurnover', base.minTurnoverUsd, 0) : base.minTurnoverUsd,
    maxTurnoverUsd: max != null ? numParam(sp, 'maxTurnover', base.maxTurnoverUsd, 1) : base.maxTurnoverUsd,
    sampling: sampling === 'stratified' || sampling === 'top' ? sampling : base.sampling,
  };
}

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const top = Math.trunc(numParam(sp, 'top', 80, 10, 200));
    const refRaw = (sp.get('ref') || 'auto') as ExchangeId | 'auto';
    const ref = ['bybit', 'bingx', 'okx', 'bitget', 'mexc', 'ourbit'].includes(refRaw) ? (refRaw as ExchangeId) : 'auto';
    const resp = await getScan(top, ref, universeFrom(sp));
    return NextResponse.json(resp);
  } catch (e) {
    console.error('[scan] failed:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'scan failed' }, { status: 500 });
  }
}

