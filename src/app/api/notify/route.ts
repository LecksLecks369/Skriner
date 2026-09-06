import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Релей уведомлений: Telegram Bot API из браузера напрямую дёргать неудобно
 * (токен в GET-строке, CORS), поэтому шлём с сервера.
 * POST { token, chatId, text }
 */
export async function POST(req: NextRequest) {
  try {
    const { token, chatId, text } = (await req.json()) as {
      token?: string;
      chatId?: string;
      text?: string;
    };
    if (!token || !chatId || !text) {
      return NextResponse.json({ error: 'нужны token, chatId, text' }, { status: 400 });
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: ctrl.signal,
        cache: 'no-store',
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (!res.ok || !j.ok) {
        return NextResponse.json({ error: j.description || `Telegram HTTP ${res.status}` }, { status: 502 });
      }
      return NextResponse.json({ ok: true });
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'notify failed' },
      { status: 500 }
    );
  }
}

