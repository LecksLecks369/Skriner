import { NextResponse } from 'next/server';
import { journalSummary, recentSignals } from '@/lib/screener/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    summary: journalSummary(),
    signals: recentSignals(60),
  });
}

