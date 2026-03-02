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
    hasDriveState: boolean;
    driveStateKeys: string[];
    foundPath: string | null;
    note?: string;
    existingPaths?: string[];
    gpsAsOf?: number | null;
    heading?: number | null;
  };
};

export interface VehicleProvider {
  key: string;
  getAuthStartUrl(state: string, redirectUri: string): string;
  exchangeCodeForToken(code: string, redirectUri: string): Promise<VehicleTokenPayload>;
  refreshToken(refreshToken: string): Promise<VehicleTokenPayload>;
  listVehicles(accessToken: string, baseUrl: string): Promise<VehicleSummary[]>;
  getTelemetrySample(accessToken: string, baseUrl: string, externalVehicleId: string): Promise<TelemetrySample>;
}
