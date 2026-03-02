import { decryptJson } from '@/lib/crypto';
import { repo } from '@/lib/db/repo';
import { getVehicleProvider } from '@/lib/providers/vehicles';
import type { VehicleTokenPayload } from '@/lib/providers/vehicles/types';

const DEV_USER_ID = process.env.DEV_USER_ID;
const DEFAULT_FLEET_BASE = process.env.TESLA_API_BASE ?? process.env.TESLA_API_BASE_URL;
const FLEET_BASE_REGEX = /(https:\/\/fleet-api\.prd\.[a-z]+\.vn\.cloud\.tesla\.com)/i;

export async function GET() {
  if (!DEV_USER_ID) {
    return new Response('Missing DEV_USER_ID', { status: 500 });
  }

  if (!DEFAULT_FLEET_BASE) {
    return new Response('Missing TESLA_API_BASE (or TESLA_API_BASE_URL)', { status: 500 });
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
    const vehicles = await provider.listVehicles(token.accessToken, initialBaseUrl);
    return Response.json({ vehicles, baseUrlUsed: initialBaseUrl });
  } catch (error) {
    const firstMessage = error instanceof Error ? error.message : 'Failed to fetch vehicles';
    const mustRegister = firstMessage.includes('must be registered');
    if (mustRegister) {
      return buildMustRegisterResponse(firstMessage);
    }

    const isOutOfRegion = firstMessage.includes('421') || firstMessage.toLowerCase().includes('out of region');
    const hintedBaseUrl = extractFleetBaseUrl(firstMessage);

    if (isOutOfRegion && hintedBaseUrl) {
      try {
        await repo.setConnectionFleetBase(conn.id, hintedBaseUrl);
      } catch {
        // Continue even if persistence fails; retry still provides best-effort healing.
      }

      try {
        const vehicles = await provider.listVehicles(token.accessToken, hintedBaseUrl);
        return Response.json({
          vehicles,
          baseUrlUsed: hintedBaseUrl,
          retried: true,
        });
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : 'Retry failed';
        if (retryMessage.includes('must be registered')) {
          return buildMustRegisterResponse(retryMessage);
        }

        return new Response(`Tesla vehicles error after retry: ${retryMessage}`, {
          status: retryMessage.includes('421') ? 421 : 500,
        });
      }
    }

    return new Response(`Tesla vehicles error: ${firstMessage}`, {
      status: isOutOfRegion ? 421 : 500,
    });
  }
}

function extractFleetBaseUrl(errorText: string): string | null {
  const match = errorText.match(FLEET_BASE_REGEX);
  return match?.[1] ?? null;
}

function buildMustRegisterResponse(details: string): Response {
  return Response.json(
    {
      error: 'Tesla account is not registered in this Fleet API region.',
      details,
      action: 'Run POST /api/vehicle/register and retry GET /api/vehicle/vehicles.',
    },
    { status: 412 },
  );
}
