import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db/client';

const DEV_USER_ID = process.env.DEV_USER_ID;

const querySchema = z.object({
  vehicleId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type EventRow = {
  id: string;
  type: string;
  ts: string;
  lat: number | string | null;
  lng: number | string | null;
  speed_kph: number | string | null;
  shift_state: string | null;
  meta: Record<string, unknown>;
  created_at: string;
};

export async function GET(req: Request) {
  if (!DEV_USER_ID) {
    return new Response('Missing DEV_USER_ID', { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({
    vehicleId: searchParams.get('vehicleId'),
    limit: searchParams.get('limit') ?? undefined,
  });

  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { data: vehicle, error: vehicleError } = await supabaseAdmin
    .from('vehicles')
    .select('id')
    .eq('id', parsed.data.vehicleId)
    .eq('user_id', DEV_USER_ID)
    .maybeSingle();

  if (vehicleError) {
    return new Response(`DB error: ${vehicleError.message}`, { status: 500 });
  }

  if (!vehicle) {
    return new Response('Vehicle not found', { status: 404 });
  }

  const { data, error } = (await supabaseAdmin
    .from('vehicle_events')
    .select('id,type,ts,lat,lng,speed_kph,shift_state,meta,created_at')
    .eq('vehicle_id', parsed.data.vehicleId)
    .order('ts', { ascending: false })
    .limit(parsed.data.limit)) as {
    data: EventRow[] | null;
    error: { message: string } | null;
  };

  if (error) {
    return new Response(`DB error: ${error.message}`, { status: 500 });
  }

  return Response.json(data ?? []);
}
