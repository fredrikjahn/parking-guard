import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { decryptJson } from '@/lib/crypto';
import { repo } from '@/lib/db/repo';
import { getVehicleProvider } from '@/lib/providers/vehicles';
import type { VehicleTokenPayload } from '@/lib/providers/vehicles/types';

const DEV_USER_ID = process.env.DEV_USER_ID;
const DEFAULT_FLEET_BASE = process.env.TESLA_API_BASE ?? process.env.TESLA_API_BASE_URL;
const FLEET_BASE_REGEX = /(https:\/\/fleet-api\.prd\.[a-z]+\.vn\.cloud\.tesla\.com)/i;

const querySchema = z.object({
  vehicleId: z.string().uuid(),
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

  const token = decryptJson<VehicleTokenPayload>({
    iv: conn.token_iv_b64,
    data: conn.token_data_b64,
  });

  const provider = getVehicleProvider('tesla_fleet');
  if (!provider) {
    return new Response('Vehicle provider not found: tesla_fleet', { status: 500 });
  }

  const initialBaseUrl = conn.fleet_api_base ?? DEFAULT_FLEET_BASE;

  try {
    const telemetry = await provider.getTelemetrySample(
      token.accessToken,
      initialBaseUrl,
      vehicle.external_vehicle_id,
    );

    return Response.json({
      vehicle: {
        id: vehicle.id,
        nickname: vehicle.nickname,
        vin: vehicle.vin,
        provider_key: vehicle.provider_key,
        external_vehicle_id: vehicle.external_vehicle_id,
      },
      baseUrlUsed: initialBaseUrl,
      telemetry,
    });
  } catch (error) {
    const firstMessage = error instanceof Error ? error.message : 'Failed to fetch telemetry';
    const hintedBaseUrl = extractFleetBaseUrl(firstMessage);
    const isOutOfRegion = firstMessage.includes('421') || firstMessage.toLowerCase().includes('out of region');

    if (isOutOfRegion && hintedBaseUrl) {
      try {
        await repo.setConnectionFleetBase(conn.id, hintedBaseUrl);
      } catch {
        // Best effort; continue with retry.
      }

      try {
        const telemetry = await provider.getTelemetrySample(
          token.accessToken,
          hintedBaseUrl,
          vehicle.external_vehicle_id,
        );

        return Response.json({
          vehicle: {
            id: vehicle.id,
            nickname: vehicle.nickname,
            vin: vehicle.vin,
            provider_key: vehicle.provider_key,
            external_vehicle_id: vehicle.external_vehicle_id,
          },
          baseUrlUsed: hintedBaseUrl,
          telemetry,
          retried: true,
        });
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : 'Retry failed';
        return new Response(`Tesla telemetry error after retry: ${retryMessage}`, {
          status: retryMessage.includes('421') ? 421 : 500,
        });
      }
    }

    return new Response(`Tesla telemetry error: ${firstMessage}`, {
      status: isOutOfRegion ? 421 : 500,
    });
  }
}

function extractFleetBaseUrl(errorText: string): string | null {
  const match = errorText.match(FLEET_BASE_REGEX);
  return match?.[1] ?? null;
}
