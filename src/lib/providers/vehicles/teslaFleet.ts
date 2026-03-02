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
    location_data?: Record<string, unknown> | null;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function extractLatLng(response: Record<string, unknown>): LatLngResult {
  const driveState = asRecord(response.drive_state);
  const locationData = asRecord(response.location_data);
  if (!driveState && !locationData) {
    return { lat: null, lng: null, foundPath: null, existingPaths: [] };
  }

  const driveStateLocation = asRecord(driveState?.location);
  const driveStatePosition = asRecord(driveState?.position);
  const locationDataLocation = asRecord(locationData?.location);
  const locationDataPosition = asRecord(locationData?.position);

  const candidates: Array<{ key: string; lat: unknown; lng: unknown }> = [
    {
      key: 'drive_state.latitude/drive_state.longitude',
      lat: driveState?.latitude,
      lng: driveState?.longitude,
    },
    {
      key: 'drive_state.lat/drive_state.lon',
      lat: driveState?.lat,
      lng: driveState?.lon,
    },
    {
      key: 'drive_state.location.lat/drive_state.location.long',
      lat: driveStateLocation?.lat,
      lng: driveStateLocation?.long,
    },
    {
      key: 'drive_state.location.lat/drive_state.location.lng',
      lat: driveStateLocation?.lat,
      lng: driveStateLocation?.lng,
    },
    {
      key: 'drive_state.position.latitude/drive_state.position.longitude',
      lat: driveStatePosition?.latitude,
      lng: driveStatePosition?.longitude,
    },
    {
      key: 'location_data.latitude/location_data.longitude',
      lat: locationData?.latitude,
      lng: locationData?.longitude,
    },
    {
      key: 'location_data.lat/location_data.lng',
      lat: locationData?.lat,
      lng: locationData?.lng,
    },
    {
      key: 'location_data.location.latitude/location_data.location.longitude',
      lat: locationDataLocation?.latitude,
      lng: locationDataLocation?.longitude,
    },
    {
      key: 'location_data.location.lat/location_data.location.lng',
      lat: locationDataLocation?.lat,
      lng: locationDataLocation?.lng,
    },
    {
      key: 'location_data.position.latitude/location_data.position.longitude',
      lat: locationDataPosition?.latitude,
      lng: locationDataPosition?.longitude,
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

function buildAuthorizeScope(rawScopes: string): string {
  const scopes = rawScopes
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const requiredScopes = ['openid', 'offline_access', 'vehicle_device_data', 'vehicle_location'];
  for (const requiredScope of requiredScopes) {
    if (!scopes.includes(requiredScope)) {
      scopes.push(requiredScope);
    }
  }

  return scopes.join(' ');
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
    url.searchParams.set('scope', buildAuthorizeScope(config.TESLA_SCOPES));
    url.searchParams.set('prompt', 'consent');
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

  async getTelemetrySample(accessToken, baseUrl, externalVehicleId, vin) {
    const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
    const vehicleRefs = Array.from(
      new Set([vin?.trim(), externalVehicleId].filter((value): value is string => Boolean(value && value.length > 0))),
    );
    const endpointSuffixes = [
      'vehicle_data?endpoints=location_data&location_data=true',
      'vehicle_data?endpoints=drive_state&location_data=true',
      'vehicle_data?location_data=true',
      'vehicle_data?endpoints=location_data,drive_state&location_data=true',
      'vehicle_data?endpoints=drive_state;location_data&location_data=true',
    ];
    const attempts: Array<{
      vehicleRef: string;
      url: string;
      ok: boolean;
      httpStatus: number;
      foundPath?: string | null;
      hasDriveState?: boolean;
      hasLocationDataBlock?: boolean;
      responseKeys?: string[];
      driveStateKeys?: string[];
      locationDataKeys?: string[];
      errorText?: string;
    }> = [];

    let lastMissingLocation:
      | {
          speedKph: number | null;
          debug: {
            usedVehicleRef: string;
            urlUsed: string;
            responseKeys: string[];
            hasLocationDataBlock: boolean;
            locationDataKeys: string[];
            hasDriveState: boolean;
            driveStateKeys: string[];
            foundPath: string | null;
            note: string;
            existingPaths: string[];
            gpsAsOf: number | null;
            heading: number | null;
            attempts: Array<{
              vehicleRef: string;
              url: string;
              ok: boolean;
              httpStatus: number;
              foundPath?: string | null;
              hasDriveState?: boolean;
              hasLocationDataBlock?: boolean;
              responseKeys?: string[];
              driveStateKeys?: string[];
              locationDataKeys?: string[];
              errorText?: string;
            }>;
          };
        }
      | null = null;
    let fallbackHttpError: string | null = null;

    for (const vehicleRef of vehicleRefs) {
      for (const suffix of endpointSuffixes) {
        const url = `${normalizedBaseUrl}/api/1/vehicles/${vehicleRef}/${suffix}`;
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          cache: 'no-store',
        });

        if (!res.ok) {
          const text = await res.text();
          attempts.push({
            vehicleRef,
            url,
            ok: false,
            httpStatus: res.status,
            errorText: text.slice(0, 240),
          });
          // Some endpoint filters can be rejected depending on backend behavior; try next candidate.
          if (res.status === 400 || res.status === 404) {
            fallbackHttpError = `Tesla vehicle_data failed: ${res.status} ${text}`;
            continue;
          }
          throw new Error(`Tesla vehicle_data failed: ${res.status} ${text}`);
        }

        const json = (await res.json()) as TeslaVehicleDataResponse;
        const resp = asRecord(json?.response) ?? {};
        const extracted = extractLatLng(resp);
        const drive = asRecord(resp.drive_state);
        const locationData = asRecord(resp.location_data);
        const speed = drive ? asFiniteNumber(drive.speed) : null;
        const attempt = {
          vehicleRef,
          url,
          ok: true,
          httpStatus: res.status,
          foundPath: extracted.foundPath,
          hasDriveState: Boolean(drive),
          hasLocationDataBlock: 'location_data' in resp,
          responseKeys: Object.keys(resp),
          driveStateKeys: drive ? Object.keys(drive) : [],
          locationDataKeys: Object.keys(locationData ?? {}),
        };
        attempts.push(attempt);
        const debug = {
          usedVehicleRef: vehicleRef,
          urlUsed: url,
          responseKeys: Object.keys(resp),
          hasLocationDataBlock: 'location_data' in resp,
          locationDataKeys: Object.keys(locationData ?? {}),
          hasDriveState: Boolean(drive),
          driveStateKeys: drive ? Object.keys(drive) : [],
          foundPath: extracted.foundPath,
          note: 'location missing in drive_state/location_data payload',
          existingPaths: extracted.existingPaths,
          gpsAsOf: drive ? asFiniteNumber(drive.gps_as_of) : null,
          heading: drive ? asFiniteNumber(drive.heading) : null,
          attempts: [...attempts],
        };

        if (extracted.lat !== null && extracted.lng !== null) {
          return {
            lat: extracted.lat,
            lng: extracted.lng,
            speedKph: speed,
            at: new Date().toISOString(),
            status: 'OK',
            debug,
          };
        }

        lastMissingLocation = {
          speedKph: speed,
          debug,
        };
      }
    }

    if (lastMissingLocation) {
      return {
        lat: null,
        lng: null,
        speedKph: lastMissingLocation.speedKph,
        at: new Date().toISOString(),
        status: 'ONLINE_NO_LOCATION',
        debug: lastMissingLocation.debug,
      };
    }

    if (fallbackHttpError) {
      throw new Error(fallbackHttpError);
    }

    throw new Error('Tesla vehicle_data failed: no usable endpoint response');
  },
};
