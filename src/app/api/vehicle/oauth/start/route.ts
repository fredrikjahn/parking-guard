import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getVehicleProvider } from '@/lib/providers/vehicles';

const querySchema = z.object({
  provider: z.string().default('tesla_fleet'),
});

export async function GET(req: NextRequest) {
  const parse = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parse.success) {
    return NextResponse.json({ error: parse.error.flatten() }, { status: 400 });
  }

  const provider = getVehicleProvider(parse.data.provider);
  if (!provider) {
    return NextResponse.json({ error: 'Unknown vehicle provider' }, { status: 400 });
  }

  const state = randomUUID();
  const redirectUri = `${req.nextUrl.origin}/api/vehicle/oauth/callback`;
  const authUrl = provider.getAuthStartUrl(state, redirectUri);

  if (req.nextUrl.searchParams.get('debug') === '1') {
    return NextResponse.json({ redirectUri, authUrl });
  }

  return NextResponse.redirect(authUrl);
}
