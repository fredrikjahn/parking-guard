import { z } from 'zod';
import { repo, type VehicleRow } from '@/lib/db/repo';
import { withVehicleAccessTokenRetry } from '@/lib/vehicleAuth';

const DEV_USER_ID = process.env.DEV_USER_ID;
const DEFAULT_FLEET_BASE = process.env.TESLA_API_BASE ?? process.env.TESLA_API_BASE_URL;
const FLEET_BASE_REGEX = /(https:\/\/fleet-api\.prd\.[a-z]+\.vn\.cloud\.tesla\.com)/i;

const bodySchema = z.object({
  vehicleId: z.string().uuid(),
});

type WakeResponse = {
  response?: unknown;
};

export async function POST(req: Request) {
  if (!DEV_USER_ID) {
    return new Response('Missing DEV_USER_ID', { status: 500 });
  }

  if (!DEFAULT_FLEET_BASE) {
    return new Response('Missing TESLA_API_BASE (or TESLA_API_BASE_URL)', { status: 500 });
  }

  const bodyJson = await req.json().catch(() => null);
  const parse = bodySchema.safeParse(bodyJson);
  if (!parse.success) {
    return Response.json({ error: parse.error.flatten() }, { status: 400 });
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

  const initialBaseUrl = conn.fleet_api_base ?? DEFAULT_FLEET_BASE;

  try {
    const response = await withVehicleAccessTokenRetry(conn, (accessToken) =>
      wakeVehicle(accessToken, initialBaseUrl, vehicle.external_vehicle_id),
    );
    return Response.json({
      vehicle: vehiclePayload(vehicle),
      baseUrlUsed: initialBaseUrl,
      response,
    });
  } catch (error) {
    const firstMessage = error instanceof Error ? error.message : 'Wake failed';
    const hintedBaseUrl = extractFleetBaseUrl(firstMessage);
    const isOutOfRegion = firstMessage.includes('421') || firstMessage.toLowerCase().includes('out of region');

    if (isOutOfRegion && hintedBaseUrl) {
      try {
        await repo.setConnectionFleetBase(conn.id, hintedBaseUrl);
      } catch {
        // Best effort; continue with retry.
      }

      try {
        const response = await withVehicleAccessTokenRetry(conn, (accessToken) =>
          wakeVehicle(accessToken, hintedBaseUrl, vehicle.external_vehicle_id),
        );
        return Response.json({
          vehicle: vehiclePayload(vehicle),
          baseUrlUsed: hintedBaseUrl,
          response,
          retried: true,
        });
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : 'Retry failed';
        return new Response(`Tesla wake error after retry: ${retryMessage}`, {
          status: inferHttpStatus(retryMessage, retryMessage.includes('421') ? 421 : 500),
        });
      }
    }

    return new Response(`Tesla wake error: ${firstMessage}`, {
      status: inferHttpStatus(firstMessage, isOutOfRegion ? 421 : 500),
    });
  }
}

async function wakeVehicle(accessToken: string, baseUrl: string, externalVehicleId: string): Promise<unknown> {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const res = await fetch(`${normalizedBaseUrl}/api/1/vehicles/${externalVehicleId}/wake_up`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: '{}',
    cache: 'no-store',
  });

  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    throw new Error(`Tesla wake_up failed: ${res.status} ${text}`);
  }

  const parsed = data as WakeResponse | null;
  return parsed?.response ?? data;
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

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
