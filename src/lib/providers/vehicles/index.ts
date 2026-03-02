import type { VehicleProvider } from './types';
import { teslaFleetProvider } from './teslaFleet';

const providers: Record<string, VehicleProvider> = {
  [teslaFleetProvider.key]: teslaFleetProvider,
};

export function getVehicleProvider(key: string): VehicleProvider | undefined {
  return providers[key];
}

export function listVehicleProviders(): VehicleProvider[] {
  return Object.values(providers);
}
