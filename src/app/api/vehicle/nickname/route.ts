import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db/client';

const DEV_USER_ID = process.env.DEV_USER_ID;

const bodySchema = z.object({
  vehicleId: z.string().uuid(),
  nickname: z.string().trim().min(1).max(40),
});

type VehicleRow = {
  id: string;
  user_id: string;
  provider_key: string;
  external_vehicle_id: string;
  display_name: string;
  vin: string | null;
  nickname: string | null;
  created_at: string;
};

export async function PATCH(req: Request) {
  if (!DEV_USER_ID) {
    return new Response('Missing DEV_USER_ID', { status: 500 });
  }

  const json = await req.json().catch(() => null);
  const parse = bodySchema.safeParse(json);
  if (!parse.success) {
    return Response.json({ error: parse.error.flatten() }, { status: 400 });
  }

  const { vehicleId, nickname } = parse.data;

  const { data, error } = (await supabaseAdmin
    .from('vehicles')
    .update({ nickname })
    .eq('id', vehicleId)
    .eq('user_id', DEV_USER_ID)
    .select('*')
    .maybeSingle()) as {
    data: VehicleRow | null;
    error: { message: string } | null;
  };

  if (error) {
    return new Response(`DB error: ${error.message}`, { status: 500 });
  }

  if (!data) {
    return new Response('Vehicle not found', { status: 404 });
  }

  return Response.json({ vehicle: data });
}
