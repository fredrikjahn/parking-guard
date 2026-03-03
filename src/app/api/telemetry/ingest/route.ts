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

type TelemetryLastRow = {
  vehicle_id: string;
  ts: string;
  lat: number | string | null;
  lng: number | string | null;
  speed_kph: number | string | null;
  shift_state: string | null;
  updated_at: string;
};

type EventType = 'MOVING' | 'PARKED' | 'MOVED';

type EventRow = {
  id: string;
  type: EventType;
  ts: string;
  lat: number | string | null;
  lng: number | string | null;
  speed_kph: number | string | null;
  shift_state: string | null;
  meta: Record<string, unknown>;
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

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toShift(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toUpperCase();
  return trimmed ? trimmed : null;
}

function isMoving(speedKph: number | null, shiftState: string | null): boolean {
  if (speedKph !== null && speedKph > 1) {
    return true;
  }
  if (shiftState === 'D' || shiftState === 'R' || shiftState === 'N') {
    return true;
  }
  return false;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthRadiusM = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(a));
}

function cooldownMsForType(type: EventType): number {
  if (type === 'PARKED') {
    return 5 * 60 * 1000;
  }
  if (type === 'MOVED') {
    return 2 * 60 * 1000;
  }
  return 0;
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

  const { data: prevSnapshot, error: prevError } = (await supabaseAdmin
    .from('vehicle_telemetry_last')
    .select('vehicle_id,ts,lat,lng,speed_kph,shift_state,updated_at')
    .eq('vehicle_id', vehicle.id)
    .maybeSingle()) as {
    data: TelemetryLastRow | null;
    error: { message: string } | null;
  };

  if (prevError) {
    return new Response(`DB error: ${prevError.message}`, { status: 500 });
  }

  const currShiftState = toShift(parse.data.shiftState ?? null);
  const currSpeedKph = parse.data.speedKph ?? null;

  const { error } = await supabaseAdmin.from('vehicle_telemetry_last').upsert(
    {
      vehicle_id: vehicle.id,
      ts: tsIso,
      lat: parse.data.lat ?? null,
      lng: parse.data.lng ?? null,
      speed_kph: currSpeedKph,
      shift_state: currShiftState,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'vehicle_id' },
  );

  if (error) {
    return new Response(`DB error: ${error.message}`, { status: 500 });
  }

  const prevLat = toFiniteNumber(prevSnapshot?.lat ?? null);
  const prevLng = toFiniteNumber(prevSnapshot?.lng ?? null);
  const prevSpeed = toFiniteNumber(prevSnapshot?.speed_kph ?? null);
  const prevShift = toShift(prevSnapshot?.shift_state ?? null);
  const currLat = parse.data.lat ?? null;
  const currLng = parse.data.lng ?? null;

  const distanceM =
    prevLat !== null && prevLng !== null && currLat !== null && currLng !== null
      ? haversineMeters(prevLat, prevLng, currLat, currLng)
      : null;

  const prevMoving = isMoving(prevSpeed, prevShift);
  const currMoving = isMoving(currSpeedKph, currShiftState);

  let eventType: EventType | null = null;
  if (prevMoving && !currMoving && currShiftState === 'P') {
    eventType = 'PARKED';
  } else if (distanceM !== null && distanceM > 20) {
    eventType = 'MOVED';
  } else if (!prevMoving && currMoving) {
    eventType = 'MOVING';
  }

  let eventEmitted: EventRow | null = null;

  if (eventType) {
    const cooldownMs = cooldownMsForType(eventType);
    let blockedByCooldown = false;

    if (cooldownMs > 0) {
      const { data: latestTypeEvent, error: latestTypeEventError } = (await supabaseAdmin
        .from('vehicle_events')
        .select('ts')
        .eq('vehicle_id', vehicle.id)
        .eq('type', eventType)
        .order('ts', { ascending: false })
        .limit(1)
        .maybeSingle()) as {
        data: { ts: string } | null;
        error: { message: string } | null;
      };

      if (latestTypeEventError) {
        return new Response(`DB error: ${latestTypeEventError.message}`, { status: 500 });
      }

      if (latestTypeEvent?.ts) {
        const diffMs = Date.parse(tsIso) - Date.parse(latestTypeEvent.ts);
        blockedByCooldown = Number.isFinite(diffMs) && diffMs >= 0 && diffMs < cooldownMs;
      }
    }

    if (!blockedByCooldown) {
      const meta = {
        distance_m: distanceM === null ? null : Math.round(distanceM * 10) / 10,
        prevMoving,
        currMoving,
      };

      const { data: insertedEvent, error: insertError } = (await supabaseAdmin
        .from('vehicle_events')
        .insert({
          vehicle_id: vehicle.id,
          type: eventType,
          ts: tsIso,
          lat: currLat,
          lng: currLng,
          speed_kph: currSpeedKph,
          shift_state: currShiftState,
          meta,
        })
        .select('id,type,ts,lat,lng,speed_kph,shift_state,meta')
        .single()) as {
        data: EventRow | null;
        error: { message: string } | null;
      };

      if (insertError) {
        return new Response(`DB error: ${insertError.message}`, { status: 500 });
      }

      eventEmitted = insertedEvent;
    }
  }

  return Response.json({
    ok: true,
    eventEmitted,
    distanceM: distanceM === null ? null : Math.round(distanceM * 10) / 10,
    prevMoving,
    currMoving,
  });
}
