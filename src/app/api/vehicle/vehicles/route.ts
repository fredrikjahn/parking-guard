import { supabaseAdmin } from '@/lib/db/client';
import { decryptJson } from '@/lib/crypto';
import { getVehicleProvider } from '@/lib/providers/vehicles';
import type { VehicleTokenPayload } from '@/lib/providers/vehicles/types';

const DEV_USER_ID = process.env.DEV_USER_ID;

export async function GET() {
  if (!DEV_USER_ID) {
    return new Response('Missing DEV_USER_ID', { status: 500 });
  }

  const { data: conn, error } = await supabaseAdmin
    .from('vehicle_connections')
    .select('*')
    .eq('user_id', DEV_USER_ID)
    .eq('provider_key', 'tesla_fleet')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return new Response(`DB error: ${error.message}`, { status: 500 });
  }

  if (!conn) {
    return new Response('No active Tesla connection', { status: 401 });
  }

  const token = decryptJson<VehicleTokenPayload>({
    iv: conn.token_iv_b64,
    data: conn.token_data_b64,
  });

  const provider = getVehicleProvider('tesla_fleet');
  if (!provider) {
    return new Response('Vehicle provider not found: tesla_fleet', { status: 500 });
  }

  try {
    const vehicles = await provider.listVehicles(token.accessToken);

    return Response.json({ vehicles });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch vehicles';
    const mustRegister = message.includes('must be registered');
    if (mustRegister) {
      return Response.json(
        {
          error: 'Tesla account is not registered in this Fleet API region.',
          details: message,
          action: 'Run POST /api/vehicle/register and retry GET /api/vehicle/vehicles.',
        },
        { status: 412 },
      );
    }

    return new Response(`Tesla vehicles error: ${message}`, { status: 500 });
  }
}
