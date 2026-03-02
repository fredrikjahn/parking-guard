import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { runTick } from '@/lib/engine/tick';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== config.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runTick();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Tick failed' },
      { status: 500 },
    );
  }
}
