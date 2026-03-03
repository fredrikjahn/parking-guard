import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db/client';

const DEV_USER_ID = process.env.DEV_USER_ID;

const querySchema = z.object({
  eventId: z.string().uuid(),
});

type EventRow = {
  id: string;
  vehicle_id: string;
};

type RuleHitRow = {
  id: string;
  vehicle_event_id: string;
  provider_key: string;
  rule_type: string;
  severity: string;
  summary: string;
  raw_json: Record<string, unknown>;
  created_at: string;
};

export async function GET(req: Request) {
  if (!DEV_USER_ID) {
    return new Response('Missing DEV_USER_ID', { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({
    eventId: searchParams.get('eventId'),
  });

  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { data: event, error: eventError } = (await supabaseAdmin
    .from('vehicle_events')
    .select('id,vehicle_id')
    .eq('id', parsed.data.eventId)
    .limit(1)
    .maybeSingle()) as {
    data: EventRow | null;
    error: { message: string } | null;
  };

  if (eventError) {
    return new Response(`DB error: ${eventError.message}`, { status: 500 });
  }

  if (!event) {
    return new Response('Event not found', { status: 404 });
  }

  const { data: vehicle, error: vehicleError } = await supabaseAdmin
    .from('vehicles')
    .select('id')
    .eq('id', event.vehicle_id)
    .eq('user_id', DEV_USER_ID)
    .limit(1)
    .maybeSingle();

  if (vehicleError) {
    return new Response(`DB error: ${vehicleError.message}`, { status: 500 });
  }

  if (!vehicle) {
    return new Response('Event does not belong to current user', { status: 404 });
  }

  const { data: hits, error: hitsError } = (await supabaseAdmin
    .from('vehicle_event_rule_hits')
    .select('id,vehicle_event_id,provider_key,rule_type,severity,summary,raw_json,created_at')
    .eq('vehicle_event_id', event.id)
    .order('created_at', { ascending: false })) as {
    data: RuleHitRow[] | null;
    error: { message: string } | null;
  };

  if (hitsError) {
    return new Response(`DB error: ${hitsError.message}`, { status: 500 });
  }

  return Response.json(hits ?? []);
}
