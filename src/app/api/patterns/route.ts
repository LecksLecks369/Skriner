import { NextResponse } from 'next/server';
import { patternStats, recentPatterns, resolvePending } from '@/lib/screener/patterns';

export const dynamic = 'force-dynamic';

/** Статистика истории паттернов: win-rate по типам + свежие сигналы с исходами */
export async function GET() {
  try {
    await resolvePending(); // дооценка нерешённых сигналов (батч ≤10, klines)
  } catch {
    /* оценка не должна ломать выдачу */
  }
  const { stats, anyWaiting } = patternStats();
  return NextResponse.json({
    stats,
    anyWaiting,
    signals: recentPatterns(120),
  });
}

