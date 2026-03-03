import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { repo, type VehicleRow } from '@/lib/db/repo';
import { getVehicleProvider } from '@/lib/providers/vehicles';
import type { TelemetrySample } from '@/lib/providers/vehicles/types';
import { withVehicleAccessTokenRetry } from '@/lib/vehicleAuth';

const DEV_USER_ID = process.env.DEV_USER_ID;
const DEFAULT_FLEET_BASE = process.env.TESLA_API_BASE ?? process.env.TESLA_API_BASE_URL;
const FLEET_BASE_REGEX = /(https:\/\/fleet-api\.prd\.[a-z]+\.vn\.cloud\.tesla\.com)/i;

const querySchema = z.object({
  vehicleId: z.string().uuid(),
  debug: z.enum(['1', 'true']).optional(),
});

export async function GET(req: NextRequest) {
  if (!DEV_USER_ID) {
    return new Response('Missing DEV_USER_ID', { status: 500 });
  }

  if (!DEFAULT_FLEET_BASE) {
    return new Response('Missing TESLA_API_BASE (or TESLA_API_BASE_URL)', { status: 500 });
  }

  const parse = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parse.success) {
    return NextResponse.json({ error: parse.error.flatten() }, { status: 400 });
  }
  const debugEnabled = Boolean(parse.data.debug);

  const vehicle = await repo.getUserVehicleById(DEV_USER_ID, parse.data.vehicleId);
  if (!vehicle) {
    return new Response('Vehicle not found', { status: 404 });
  }

  if (vehicle.provider_key !== 'tesla_fleet') {
    return new Response('Telemetry not implemented for provider', { status: 400 });
  }

  const conn = await repo.getTeslaConnection(DEV_USER_ID);
  if (!conn) {
    return new Response('No active Tesla connection', { status: 401 });
  }

  const provider = getVehicleProvider('tesla_fleet');
  if (!provider) {
    return new Response('Vehicle provider not found: tesla_fleet', { status: 500 });
  }

  const initialBaseUrl = conn.fleet_api_base ?? DEFAULT_FLEET_BASE;

  try {
    const telemetry = await withVehicleAccessTokenRetry(conn, (accessToken) =>
      provider.getTelemetrySample(
        accessToken,
        initialBaseUrl,
        vehicle.external_vehicle_id,
        vehicle.vin ?? undefined,
      ),
    );
    await upsertLastKnownLocationBestEffort(vehicle, telemetry);

    return Response.json(formatTelemetryResponse(vehicle, initialBaseUrl, telemetry, debugEnabled));
  } catch (error) {
    const firstMessage = error instanceof Error ? error.message : 'Failed to fetch telemetry';
    if (isVehicleAsleepError(firstMessage)) {
      return Response.json({
        vehicle: vehiclePayload(vehicle),
        baseUrlUsed: initialBaseUrl,
        telemetry: null,
        vehicleStatus: 'ASLEEP',
        message: 'Vehicle is offline or asleep. Try again later or call /api/vehicle/wake.',
      });
    }

    const hintedBaseUrl = extractFleetBaseUrl(firstMessage);
    const isOutOfRegion = firstMessage.includes('421') || firstMessage.toLowerCase().includes('out of region');

    if (isOutOfRegion && hintedBaseUrl) {
      try {
        await repo.setConnectionFleetBase(conn.id, hintedBaseUrl);
      } catch {
        // Best effort; continue with retry.
      }

      try {
        const telemetry = await withVehicleAccessTokenRetry(conn, (accessToken) =>
          provider.getTelemetrySample(
            accessToken,
            hintedBaseUrl,
            vehicle.external_vehicle_id,
            vehicle.vin ?? undefined,
          ),
        );
        await upsertLastKnownLocationBestEffort(vehicle, telemetry);

        return Response.json({
          ...formatTelemetryResponse(vehicle, hintedBaseUrl, telemetry, debugEnabled),
          retried: true,
        });
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : 'Retry failed';
        if (isVehicleAsleepError(retryMessage)) {
          return Response.json({
            vehicle: vehiclePayload(vehicle),
            baseUrlUsed: hintedBaseUrl,
            telemetry: null,
            vehicleStatus: 'ASLEEP',
            message: 'Vehicle is offline or asleep. Try again later or call /api/vehicle/wake.',
            retried: true,
          });
        }

        return new Response(`Tesla telemetry error after retry: ${retryMessage}`, {
          status: inferHttpStatus(retryMessage, retryMessage.includes('421') ? 421 : 500),
        });
      }
    }

    return new Response(`Tesla telemetry error: ${firstMessage}`, {
      status: inferHttpStatus(firstMessage, isOutOfRegion ? 421 : 500),
    });
  }
}

function formatTelemetryResponse(
  vehicle: VehicleRow,
  baseUrlUsed: string,
  telemetry: TelemetrySample,
  debugEnabled: boolean,
) {
  const isOnlineNoLocation =
    telemetry.status === 'ONLINE_NO_LOCATION' || telemetry.lat === null || telemetry.lng === null;
  const response: Record<string, unknown> = {
    vehicle: vehiclePayload(vehicle),
    baseUrlUsed,
    vehicleStatus: isOnlineNoLocation ? 'ONLINE_NO_LOCATION' : 'OK',
    telemetry: isOnlineNoLocation
      ? null
      : {
          lat: telemetry.lat,
          lng: telemetry.lng,
          speedKph: telemetry.speedKph,
          at: telemetry.at,
        },
  };

  if (isOnlineNoLocation) {
    response.message = 'Vehicle is online but no location was returned by vehicle_data.';
  }

  if (debugEnabled && telemetry.debug) {
    response.debug = {
      usedVehicleRef: telemetry.debug.usedVehicleRef,
      urlUsed: telemetry.debug.urlUsed,
      responseKeys: telemetry.debug.responseKeys ?? [],
      hasLocationDataBlock: telemetry.debug.hasLocationDataBlock ?? false,
      locationDataKeys: telemetry.debug.locationDataKeys ?? [],
      hasDriveState: telemetry.debug.hasDriveState,
      driveStateKeys: telemetry.debug.driveStateKeys,
      foundPath: telemetry.debug.foundPath,
      note: telemetry.debug.note ?? (isOnlineNoLocation ? 'location missing in drive_state payload' : undefined),
      attempts: telemetry.debug.attempts ?? [],
    };
  }

  return response;
}

function vehiclePayload(vehicle: VehicleRow) {
  return {
    id: vehicle.id,
    nickname: vehicle.nickname,
    vin: vehicle.vin,
    provider_key: vehicle.provider_key,
    external_vehicle_id: vehicle.external_vehicle_id,
  };
}

function extractFleetBaseUrl(errorText: string): string | null {
  const match = errorText.match(FLEET_BASE_REGEX);
  return match?.[1] ?? null;
}

function isVehicleAsleepError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('408') && (lower.includes('offline or asleep') || lower.includes('offline') || lower.includes('asleep'));
}

function inferHttpStatus(message: string, fallback: number): number {
  const match = message.match(/failed:\s*(\d{3})/i);
  if (!match) {
    return fallback;
  }

  const code = Number.parseInt(match[1], 10);
  if (!Number.isFinite(code)) {
    return fallback;
  }

  if (code < 400 || code > 599) {
    return fallback;
  }

  return code;
}

function toGpsAsOfIso(gpsAsOf: unknown): string | null {
  if (typeof gpsAsOf !== 'number' || !Number.isFinite(gpsAsOf)) {
    return null;
  }

  const ms = gpsAsOf > 1_000_000_000_000 ? gpsAsOf : gpsAsOf * 1000;
  const iso = new Date(ms).toISOString();
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

async function upsertLastKnownLocationBestEffort(vehicle: VehicleRow, telemetry: TelemetrySample): Promise<void> {
  if (telemetry.lat === null || telemetry.lng === null) {
    return;
  }

  try {
    await repo.upsertVehicleLastLocation({
      user_id: vehicle.user_id,
      vehicle_id: vehicle.id,
      lat: telemetry.lat,
      lng: telemetry.lng,
      gps_as_of: toGpsAsOfIso(telemetry.debug?.gpsAsOf),
      source: 'telemetry',
    });
  } catch {
    // Best effort only; telemetry endpoint response should still succeed.
  }
}
