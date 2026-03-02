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

  async getTelemetrySample(_accessToken, _externalVehicleId, _baseUrl) {
    throw new Error('Tesla getTelemetrySample is not implemented yet');
  },
};
