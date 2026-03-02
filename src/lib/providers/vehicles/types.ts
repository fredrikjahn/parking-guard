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
  lat: number;
  lng: number;
  speedKph: number;
};

export interface VehicleProvider {
  key: string;
  getAuthStartUrl(state: string, redirectUri: string): string;
  exchangeCodeForToken(code: string, redirectUri: string): Promise<VehicleTokenPayload>;
  refreshToken(refreshToken: string): Promise<VehicleTokenPayload>;
  listVehicles(accessToken: string): Promise<VehicleSummary[]>;
  getTelemetrySample(accessToken: string, externalVehicleId: string): Promise<TelemetrySample>;
}
