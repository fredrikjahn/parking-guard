import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { encryptJson } from '@/lib/crypto';
import { config } from '@/lib/config';
import { repo } from '@/lib/db/repo';
import { getVehicleProvider } from '@/lib/providers/vehicles';

const querySchema = z.object({
  code: z.string().min(1),
  state: z.string().optional(),
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

  try {
    const redirectUri = `${req.nextUrl.origin}/api/vehicle/oauth/callback`;
    const token = await provider.exchangeCodeForToken(parse.data.code, redirectUri);
    const encrypted = encryptJson(token);

    await repo.createVehicleConnection({
      user_id: config.DEV_USER_ID,
      provider_key: provider.key,
      token_iv_b64: encrypted.iv,
      token_data_b64: encrypted.data,
      expires_at: token.expiresAt ?? null,
      status: 'active',
    });

    try {
      const vehicles = await provider.listVehicles(token.accessToken);
      const firstVehicle = vehicles[0];
      if (firstVehicle) {
        await repo.upsertVehicle({
          user_id: config.DEV_USER_ID,
          provider_key: provider.key,
          external_vehicle_id: firstVehicle.externalId,
          display_name: firstVehicle.name,
          vin: firstVehicle.vin ?? null,
        });
      }
    } catch {
      await repo.upsertVehicle({
        user_id: config.DEV_USER_ID,
        provider_key: provider.key,
        external_vehicle_id: config.DEV_EXTERNAL_VEHICLE_ID,
        display_name: 'Dev Vehicle (placeholder)',
        vin: null,
      });
    }

    return NextResponse.json({ ok: true, provider: provider.key, state: parse.data.state ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'OAuth callback failed' },
      { status: 500 },
    );
  }
}
