import { supabaseAdmin } from '@/lib/db/client';
import { repo } from '@/lib/db/repo';
import { getVehicleProvider } from '@/lib/providers/vehicles';
import type { VehicleSummary } from '@/lib/providers/vehicles/types';
import { withVehicleAccessTokenRetry } from '@/lib/vehicleAuth';

const DEV_USER_ID = process.env.DEV_USER_ID;
const DEFAULT_FLEET_BASE = process.env.TESLA_API_BASE ?? process.env.TESLA_API_BASE_URL;
const FLEET_BASE_REGEX = /(https:\/\/fleet-api\.prd\.[a-z]+\.vn\.cloud\.tesla\.com)/i;

type ExistingVehicleRow = {
  id: string;
  nickname: string | null;
};

type SyncedVehicleRow = {
  id: string;
  user_id: string;
  provider_key: string;
  external_vehicle_id: string;
  display_name: string;
  vin: string | null;
  nickname: string | null;
  created_at: string;
};

export async function POST() {
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

  const provider = getVehicleProvider('tesla_fleet');
  if (!provider) {
    return new Response('Vehicle provider not found: tesla_fleet', { status: 500 });
  }

  let baseUrlUsed = conn.fleet_api_base ?? DEFAULT_FLEET_BASE;
  let providerVehicles: VehicleSummary[];

  try {
    providerVehicles = await withVehicleAccessTokenRetry(conn, (accessToken) =>
      provider.listVehicles(accessToken, baseUrlUsed),
    );
  } catch (error) {
    const firstMessage = error instanceof Error ? error.message : 'Failed to fetch vehicles';

    const mustRegister = firstMessage.includes('must be registered');
    if (mustRegister) {
      return Response.json(
        {
          error: 'Tesla account is not registered in this Fleet API region.',
          details: firstMessage,
          action: 'Run POST /api/vehicle/register and retry POST /api/vehicle/sync.',
        },
        { status: 412 },
      );
    }

    const hintedBaseUrl = extractFleetBaseUrl(firstMessage);
    const isOutOfRegion = firstMessage.includes('421') || firstMessage.toLowerCase().includes('out of region');

    if (!isOutOfRegion || !hintedBaseUrl) {
      return new Response(`Tesla sync failed: ${firstMessage}`, {
        status: isOutOfRegion ? 421 : 500,
      });
    }

    try {
      await repo.setConnectionFleetBase(conn.id, hintedBaseUrl);
    } catch {
      // Best effort; continue with retry.
    }

    try {
      providerVehicles = await withVehicleAccessTokenRetry(conn, (accessToken) =>
        provider.listVehicles(accessToken, hintedBaseUrl),
      );
      baseUrlUsed = hintedBaseUrl;
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : 'Retry failed';
      if (retryMessage.includes('must be registered')) {
        return Response.json(
          {
            error: 'Tesla account is not registered in this Fleet API region.',
            details: retryMessage,
            action: 'Run POST /api/vehicle/register and retry POST /api/vehicle/sync.',
          },
          { status: 412 },
        );
      }

      return new Response(`Tesla sync failed after retry: ${retryMessage}`, {
        status: retryMessage.includes('421') ? 421 : 500,
      });
    }
  }

  try {
    const syncedVehicles: SyncedVehicleRow[] = [];

    for (const vehicle of providerVehicles) {
      const { data: existing, error: existingError } = (await supabaseAdmin
        .from('vehicles')
        .select('id,nickname')
        .eq('user_id', DEV_USER_ID)
        .eq('provider_key', 'tesla_fleet')
        .eq('external_vehicle_id', vehicle.externalId)
        .limit(1)
        .maybeSingle()) as {
        data: ExistingVehicleRow | null;
        error: { message: string } | null;
      };

      if (existingError) {
        throw new Error(`sync.existing lookup failed: ${existingError.message}`);
      }

      const nickname = existing?.nickname ?? buildDefaultNickname(vehicle.name, vehicle.vin);

      const { data: upserted, error: upsertError } = (await supabaseAdmin
        .from('vehicles')
        .upsert(
          {
            user_id: DEV_USER_ID,
            provider_key: 'tesla_fleet',
            external_vehicle_id: vehicle.externalId,
            display_name: vehicle.name,
            vin: vehicle.vin,
            nickname,
          },
          { onConflict: 'user_id,provider_key,external_vehicle_id' },
        )
        .select('*')
        .single()) as {
        data: SyncedVehicleRow | null;
        error: { message: string } | null;
      };

      if (upsertError || !upserted) {
        throw new Error(`sync.upsert failed: ${upsertError?.message ?? 'missing row'}`);
      }

      syncedVehicles.push(upserted);
    }

    return Response.json({
      synced: syncedVehicles.length,
      baseUrlUsed,
      vehicles: syncedVehicles,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Vehicle sync failed';
    return new Response(`Vehicle sync failed: ${message}`, { status: 500 });
  }
}

function buildDefaultNickname(providerName: string, vin: string | null): string {
  const trimmedName = providerName.trim();
  if (trimmedName.length > 0) {
    return trimmedName;
  }

  if (vin && vin.trim().length > 0) {
    const cleanVin = vin.trim();
    return `Tesla •${cleanVin.slice(-4)}`;
  }

  return 'Min bil';
}

function extractFleetBaseUrl(errorText: string): string | null {
  const match = errorText.match(FLEET_BASE_REGEX);
  return match?.[1] ?? null;
}
