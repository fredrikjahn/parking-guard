import { decryptJson, encryptJson } from '@/lib/crypto';
import { repo, type VehicleConnectionRow } from '@/lib/db/repo';
import { getVehicleProvider } from '@/lib/providers/vehicles';
import type { VehicleTokenPayload } from '@/lib/providers/vehicles/types';

const EXPIRY_SKEW_MS = 60_000;

function isTokenExpiredOrExpiring(expiresAt?: string): boolean {
  if (!expiresAt) {
    return false;
  }

  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) {
    return false;
  }

  return expiresMs - Date.now() <= EXPIRY_SKEW_MS;
}

export function isAuthTokenErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  const hasAuthStatus = lower.includes('401') || lower.includes('unauthorized');
  if (!hasAuthStatus) {
    return false;
  }

  return (
    lower.includes('token expired') ||
    lower.includes('invalid token') ||
    lower.includes('invalid bearer') ||
    lower.includes('unauthorized')
  );
}

async function refreshAndPersistToken(
  connection: VehicleConnectionRow,
  refreshToken: string,
): Promise<VehicleTokenPayload> {
  const provider = getVehicleProvider(connection.provider_key);
  if (!provider) {
    throw new Error(`Vehicle provider not found: ${connection.provider_key}`);
  }

  const refreshedToken = await provider.refreshToken(refreshToken);
  const encrypted = encryptJson(refreshedToken);

  await repo.updateVehicleConnectionToken(connection.id, {
    token_iv_b64: encrypted.iv,
    token_data_b64: encrypted.data,
    expires_at: refreshedToken.expiresAt ?? null,
  });

  return refreshedToken;
}

export async function ensureFreshVehicleToken(
  connection: VehicleConnectionRow,
): Promise<VehicleTokenPayload> {
  const token = decryptJson<VehicleTokenPayload>({
    iv: connection.token_iv_b64,
    data: connection.token_data_b64,
  });

  if (!isTokenExpiredOrExpiring(token.expiresAt)) {
    return token;
  }

  if (!token.refreshToken) {
    return token;
  }

  return refreshAndPersistToken(connection, token.refreshToken);
}

export async function withVehicleAccessTokenRetry<T>(
  connection: VehicleConnectionRow,
  action: (accessToken: string) => Promise<T>,
): Promise<T> {
  let token = await ensureFreshVehicleToken(connection);

  try {
    return await action(token.accessToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAuthTokenErrorMessage(message) || !token.refreshToken) {
      throw error;
    }

    token = await refreshAndPersistToken(connection, token.refreshToken);
    return action(token.accessToken);
  }
}
