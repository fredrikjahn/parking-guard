import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db/client';

const bodySchema = z
  .object({
    source: z.literal('tesla'),
    vehicleRef: z
      .object({
        vin: z.string().trim().min(1).optional(),
        externalVehicleId: z.string().trim().min(1).optional(),
      })
      .refine((value) => Boolean(value.vin || value.externalVehicleId), {
        message: 'vehicleRef.vin or vehicleRef.externalVehicleId is required',
        path: ['vehicleRef'],
      }),
    ts: z.union([z.string(), z.number()]),
    lat: z.number().finite().optional().nullable(),
    lng: z.number().finite().optional().nullable(),
    speedKph: z.number().finite().optional().nullable(),
    shiftState: z.string().trim().min(1).optional().nullable(),
    rawKeys: z.array(z.string()).optional(),
  })
  .strict();

type VehicleLookupRow = {
  id: string;
  user_id: string;
};

function normalizeTs(value: string | number): string {
  if (typeof value === 'number') {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Invalid ts');
  }
  return new Date(parsed).toISOString();
}

async function findVehicle(ref: { vin?: string; externalVehicleId?: string }): Promise<VehicleLookupRow | null> {
  if (ref.vin) {
    const { data, error } = (await supabaseAdmin
      .from('vehicles')
      .select('id,user_id')
      .eq('provider_key', 'tesla_fleet')
      .eq('vin', ref.vin)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()) as {
      data: VehicleLookupRow | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new Error(`Vehicle lookup by vin failed: ${error.message}`);
    }
    if (data) {
      return data;
    }
  }

  if (ref.externalVehicleId) {
    const { data, error } = (await supabaseAdmin
      .from('vehicles')
      .select('id,user_id')
      .eq('provider_key', 'tesla_fleet')
      .eq('external_vehicle_id', ref.externalVehicleId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()) as {
      data: VehicleLookupRow | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new Error(`Vehicle lookup by external id failed: ${error.message}`);
    }
    if (data) {
      return data;
    }
  }

  return null;
}

export async function POST(req: Request) {
  const expectedSecret = process.env.TELEMETRY_INGEST_SECRET;
  if (!expectedSecret) {
    return new Response('Missing TELEMETRY_INGEST_SECRET', { status: 500 });
  }

  const secret = req.headers.get('x-telemetry-secret');
  if (!secret || secret !== expectedSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parse = bodySchema.safeParse(json);
  if (!parse.success) {
    return Response.json({ error: parse.error.flatten() }, { status: 400 });
  }

  let tsIso: string;
  try {
    tsIso = normalizeTs(parse.data.ts);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Invalid ts', { status: 400 });
  }

  const vehicle = await findVehicle(parse.data.vehicleRef);
  if (!vehicle) {
    return new Response('Vehicle not found for vehicleRef', { status: 404 });
  }

  const { error } = await supabaseAdmin.from('vehicle_telemetry_last').upsert(
    {
      vehicle_id: vehicle.id,
      ts: tsIso,
      lat: parse.data.lat ?? null,
      lng: parse.data.lng ?? null,
      speed_kph: parse.data.speedKph ?? null,
      shift_state: parse.data.shiftState ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'vehicle_id' },
  );

  if (error) {
    return new Response(`DB error: ${error.message}`, { status: 500 });
  }

  return Response.json({ ok: true });
}
