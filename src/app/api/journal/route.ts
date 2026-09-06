import { NextResponse } from 'next/server';
import { journalSummary, recentSignals } from '@/lib/screener/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({
      summary: journalSummary(),
      signals: recentSignals(60),
    });
  } catch (e) {
    // журнал читается с диска: битый/обрезанный файл не должен ронять роут без внятного ответа
    console.error('[journal] failed:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'journal failed' }, { status: 500 });
  }
}

