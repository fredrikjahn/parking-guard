import { supabaseAdmin } from '@/lib/db/client';

const DEV_USER_ID = process.env.DEV_USER_ID;

type UiVehicleRow = {
  id: string;
  nickname: string | null;
  vin: string | null;
  external_vehicle_id: string;
  created_at: string;
};

export async function GET() {
  if (!DEV_USER_ID) {
    return new Response('Missing DEV_USER_ID', { status: 500 });
  }

  const { data, error } = (await supabaseAdmin
    .from('vehicles')
    .select('id,nickname,vin,external_vehicle_id,created_at')
    .eq('user_id', DEV_USER_ID)
    .eq('provider_key', 'tesla_fleet')
    .order('created_at', { ascending: false })) as {
    data: UiVehicleRow[] | null;
    error: { message: string } | null;
  };

  if (error) {
    return new Response(`DB error: ${error.message}`, { status: 500 });
  }

  return Response.json(data ?? []);
}
