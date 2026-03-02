import { config } from '@/lib/config';
import type { VehicleProvider, VehicleSummary, VehicleTokenPayload } from './types';

type TeslaTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
};

type TeslaVehiclesResponse = {
  response?: Array<{
    id?: string | number;
    display_name?: string | null;
    vin?: string | null;
    vehicle_config?: {
      car_type?: string | null;
    } | null;
  }>;
};

type TeslaVehicleDataResponse = {
  response?: {
    state?: string | null;
    drive_state?: Record<string, unknown> | null;
  } | null;
};

type LatLngResult = {
  lat: number | null;
  lng: number | null;
  foundPath: string | null;
  existingPaths: string[];
};

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractLatLng(driveState: unknown): LatLngResult {
  if (!driveState || typeof driveState !== 'object') {
    return { lat: null, lng: null, foundPath: null, existingPaths: [] };
  }

  const state = driveState as Record<string, unknown>;

  const candidates: Array<{ key: string; lat: unknown; lng: unknown }> = [
    {
      key: 'drive_state.latitude/drive_state.longitude',
      lat: state.latitude,
      lng: state.longitude,
    },
    {
      key: 'drive_state.lat/drive_state.lon',
      lat: state.lat,
      lng: state.lon,
    },
    {
      key: 'drive_state.location.lat/drive_state.location.long',
      lat:
        state.location && typeof state.location === 'object'
          ? (state.location as Record<string, unknown>).lat
          : null,
      lng:
        state.location && typeof state.location === 'object'
          ? (state.location as Record<string, unknown>).long
          : null,
    },
    {
      key: 'drive_state.location.lat/drive_state.location.lng',
      lat:
        state.location && typeof state.location === 'object'
          ? (state.location as Record<string, unknown>).lat
          : null,
      lng:
        state.location && typeof state.location === 'object'
          ? (state.location as Record<string, unknown>).lng
          : null,
    },
    {
      key: 'drive_state.position.latitude/drive_state.position.longitude',
      lat:
        state.position && typeof state.position === 'object'
          ? (state.position as Record<string, unknown>).latitude
          : null,
      lng:
        state.position && typeof state.position === 'object'
          ? (state.position as Record<string, unknown>).longitude
          : null,
    },
  ];

  const existingPaths = candidates
    .filter((candidate) => candidate.lat !== undefined || candidate.lng !== undefined)
    .map((candidate) => candidate.key);

  for (const candidate of candidates) {
    const lat = asFiniteNumber(candidate.lat);
    const lng = asFiniteNumber(candidate.lng);
    if (lat !== null && lng !== null) {
      return {
        lat,
        lng,
        foundPath: candidate.key,
        existingPaths,
      };
    }
  }

  return {
    lat: null,
    lng: null,
    foundPath: null,
    existingPaths,
  };
}

function getTokenEndpoint(): string {
  return `${config.TESLA_AUTH_BASE_URL}/oauth2/v3/token`;
}

function toTokenPayload(raw: TeslaTokenResponse): VehicleTokenPayload {
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    tokenType: raw.token_type,
    scope: raw.scope,
    expiresAt: raw.expires_in ? new Date(Date.now() + raw.expires_in * 1000).toISOString() : undefined,
    raw,
  };
}

export const teslaFleetProvider: VehicleProvider = {
  key: 'tesla_fleet',

  getAuthStartUrl(state, redirectUri) {
    const url = new URL(`${config.TESLA_AUTH_BASE_URL}/oauth2/v3/authorize`);
    url.searchParams.set('client_id', config.TESLA_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', config.TESLA_SCOPES);
    url.searchParams.set('state', state);
    return url.toString();
  },

  async exchangeCodeForToken(code, redirectUri) {
    // TODO: Verify exact Tesla Fleet OAuth token endpoint and required headers.
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.TESLA_CLIENT_ID,
      client_secret: config.TESLA_CLIENT_SECRET,
      redirect_uri: redirectUri,
    });

    const response = await fetch(getTokenEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Tesla token exchange failed (${response.status})`);
    }

    const raw = (await response.json()) as TeslaTokenResponse;
    return toTokenPayload(raw);
  },

  async refreshToken(refreshToken) {
    // TODO: Verify exact Tesla Fleet refresh token request shape.
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.TESLA_CLIENT_ID,
      client_secret: config.TESLA_CLIENT_SECRET,
    });

    const response = await fetch(getTokenEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Tesla refresh token failed (${response.status})`);
    }

    const raw = (await response.json()) as TeslaTokenResponse;
    return toTokenPayload(raw);
  },

  async listVehicles(accessToken, baseUrl): Promise<VehicleSummary[]> {
    const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
    const res = await fetch(`${normalizedBaseUrl}/api/1/vehicles`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Tesla listVehicles failed: ${res.status} ${text}`);
    }

    const json = (await res.json()) as TeslaVehiclesResponse;
    const arr = Array.isArray(json?.response) ? json.response : [];

    return arr
      .map((v) => {
        if (v.id === undefined || v.id === null) {
          return null;
        }

        return {
          externalId: String(v.id),
          name: v.display_name ?? v.vehicle_config?.car_type ?? 'Tesla',
          vin: v.vin ?? null,
        };
      })
      .filter((v): v is VehicleSummary => v !== null);
  },

  async getTelemetrySample(accessToken, baseUrl, externalVehicleId) {
    const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
    const res = await fetch(`${normalizedBaseUrl}/api/1/vehicles/${externalVehicleId}/vehicle_data`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Tesla vehicle_data failed: ${res.status} ${text}`);
    }

    const json = (await res.json()) as TeslaVehicleDataResponse;
    const driveState = json?.response?.drive_state ?? null;
    const extracted = extractLatLng(driveState);
    const drive =
      driveState && typeof driveState === 'object' ? (driveState as Record<string, unknown>) : undefined;
    const speed = drive ? asFiniteNumber(drive.speed) : null;
    if (extracted.lat === null || extracted.lng === null) {
      return {
        lat: null,
        lng: null,
        speedKph: speed,
        at: new Date().toISOString(),
        status: 'ONLINE_NO_LOCATION',
        debug: {
          hasDriveState: Boolean(driveState),
          driveStateKeys: drive ? Object.keys(drive) : [],
          foundPath: extracted.foundPath,
          note: 'location missing in drive_state payload',
          existingPaths: extracted.existingPaths,
          gpsAsOf: drive ? asFiniteNumber(drive.gps_as_of) : null,
          heading: drive ? asFiniteNumber(drive.heading) : null,
        },
      };
    }

    return {
      lat: extracted.lat,
      lng: extracted.lng,
      speedKph: speed,
      at: new Date().toISOString(),
      status: 'OK',
      debug: {
        hasDriveState: Boolean(driveState),
        driveStateKeys: drive ? Object.keys(drive) : [],
        foundPath: extracted.foundPath,
        existingPaths: extracted.existingPaths,
        gpsAsOf: drive ? asFiniteNumber(drive.gps_as_of) : null,
        heading: drive ? asFiniteNumber(drive.heading) : null,
      },
    };
  },
};
