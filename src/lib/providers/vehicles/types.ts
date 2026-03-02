export type VehicleTokenPayload = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAt?: string;
  raw?: unknown;
};

export type VehicleSummary = {
  externalId: string;
  name: string;
  vin: string | null;
};

export type TelemetrySample = {
  lat: number | null;
  lng: number | null;
  speedKph: number | null;
  at: string;
  status?: 'OK' | 'ONLINE_NO_LOCATION';
  debug?: {
    usedVehicleRef?: string;
    urlUsed?: string;
    responseKeys?: string[];
    hasLocationDataBlock?: boolean;
    locationDataKeys?: string[];
    hasDriveState: boolean;
    driveStateKeys: string[];
    foundPath: string | null;
    note?: string;
    existingPaths?: string[];
    gpsAsOf?: number | null;
    heading?: number | null;
    attempts?: Array<{
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
};

export interface VehicleProvider {
  key: string;
  getAuthStartUrl(state: string, redirectUri: string): string;
  exchangeCodeForToken(code: string, redirectUri: string): Promise<VehicleTokenPayload>;
  refreshToken(refreshToken: string): Promise<VehicleTokenPayload>;
  listVehicles(accessToken: string, baseUrl: string): Promise<VehicleSummary[]>;
  getTelemetrySample(
    accessToken: string,
    baseUrl: string,
    externalVehicleId: string,
    vin?: string,
  ): Promise<TelemetrySample>;
}
