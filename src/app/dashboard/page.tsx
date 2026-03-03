'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type UiVehicle = {
  id: string;
  nickname: string | null;
  vin: string | null;
  external_vehicle_id: string;
  created_at: string;
};

type TelemetryPayload = {
  vehicleStatus?: string;
  message?: string;
  telemetry?: {
    lat: number;
    lng: number;
    speedKph: number | null;
    at: string;
  } | null;
  debug?: unknown;
};

type VehicleUiState = {
  wakeLoading?: boolean;
  wakeMessage?: string;
  wakeError?: string;
  positionLoading?: boolean;
  telemetryLoading?: boolean;
  telemetryError?: string;
  telemetryData?: TelemetryPayload;
  nicknameSaving?: boolean;
  nicknameError?: string;
  nicknameSuccess?: string;
};

function vinSuffix(vin: string | null): string {
  if (!vin) return 'okand';
  const trimmed = vin.trim();
  if (!trimmed) return 'okand';
  return trimmed.slice(-4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readError(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (json && typeof json.error === 'string') {
      return json.error;
    }
    if (json && typeof json.message === 'string') {
      return json.message;
    }
    if (json) {
      return JSON.stringify(json);
    }
  }

  const text = await res.text().catch(() => '');
  return text || `Request failed (${res.status})`;
}

export default function DashboardPage() {
  const [vehicles, setVehicles] = useState<UiVehicle[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(true);
  const [vehiclesError, setVehiclesError] = useState<string | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [nicknameDrafts, setNicknameDrafts] = useState<Record<string, string>>({});
  const [vehicleState, setVehicleState] = useState<Record<string, VehicleUiState>>({});

  const patchVehicleState = useCallback((vehicleId: string, patch: Partial<VehicleUiState>) => {
    setVehicleState((prev) => ({
      ...prev,
      [vehicleId]: {
        ...(prev[vehicleId] ?? {}),
        ...patch,
      },
    }));
  }, []);

  const loadVehicles = useCallback(async () => {
    setVehiclesLoading(true);
    setVehiclesError(null);
    try {
      const res = await fetch('/api/ui/vehicles', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(await readError(res));
      }
      const json = (await res.json()) as unknown;
      const nextVehicles = Array.isArray(json) ? (json as UiVehicle[]) : [];
      setVehicles(nextVehicles);
      setNicknameDrafts((prev) => {
        const next: Record<string, string> = {};
        for (const vehicle of nextVehicles) {
          next[vehicle.id] = prev[vehicle.id] ?? vehicle.nickname ?? '';
        }
        return next;
      });
    } catch (error) {
      setVehiclesError(error instanceof Error ? error.message : 'Kunde inte hamta bilar');
    } finally {
      setVehiclesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVehicles();
  }, [loadVehicles]);

  const syncVehicles = useCallback(async () => {
    setSyncLoading(true);
    setSyncMessage(null);
    setSyncError(null);
    try {
      const res = await fetch('/api/vehicle/sync', { method: 'POST' });
      if (!res.ok) {
        throw new Error(await readError(res));
      }
      const json = (await res.json().catch(() => null)) as { synced?: number } | null;
      setSyncMessage(`Sync klar${typeof json?.synced === 'number' ? ` (${json.synced} bil${json.synced === 1 ? '' : 'ar'})` : ''}.`);
      await loadVehicles();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Sync misslyckades');
    } finally {
      setSyncLoading(false);
    }
  }, [loadVehicles]);

  const wakeVehicle = useCallback(
    async (vehicleId: string, silentSuccess = false): Promise<boolean> => {
      patchVehicleState(vehicleId, {
        wakeLoading: true,
        wakeError: undefined,
        ...(silentSuccess ? {} : { wakeMessage: undefined }),
      });
      try {
        const res = await fetch('/api/vehicle/wake', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ vehicleId }),
        });
        if (!res.ok) {
          throw new Error(await readError(res));
        }
        const json = (await res.json().catch(() => null)) as
          | { response?: { state?: string } }
          | null;
        patchVehicleState(vehicleId, {
          wakeLoading: false,
          wakeMessage: silentSuccess ? undefined : `Wake skickad${json?.response?.state ? ` (${json.response.state})` : ''}.`,
          wakeError: undefined,
        });
        return true;
      } catch (error) {
        patchVehicleState(vehicleId, {
          wakeLoading: false,
          wakeError: error instanceof Error ? error.message : 'Wake misslyckades',
        });
        return false;
      }
    },
    [patchVehicleState],
  );

  const fetchTelemetry = useCallback(
    async (vehicleId: string): Promise<void> => {
      patchVehicleState(vehicleId, {
        telemetryLoading: true,
        telemetryError: undefined,
      });
      try {
        const res = await fetch(`/api/vehicle/telemetry?vehicleId=${encodeURIComponent(vehicleId)}&debug=1`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          throw new Error(await readError(res));
        }
        const json = (await res.json()) as TelemetryPayload;
        patchVehicleState(vehicleId, {
          telemetryLoading: false,
          telemetryData: json,
          telemetryError: undefined,
        });
      } catch (error) {
        patchVehicleState(vehicleId, {
          telemetryLoading: false,
          telemetryError: error instanceof Error ? error.message : 'Telemetry misslyckades',
        });
      }
    },
    [patchVehicleState],
  );

  const fetchPosition = useCallback(
    async (vehicleId: string): Promise<void> => {
      patchVehicleState(vehicleId, { positionLoading: true });
      try {
        await wakeVehicle(vehicleId, true);
        await sleep(1500);
        await fetchTelemetry(vehicleId);
      } finally {
        patchVehicleState(vehicleId, { positionLoading: false });
      }
    },
    [fetchTelemetry, patchVehicleState, wakeVehicle],
  );

  const saveNickname = useCallback(
    async (vehicleId: string): Promise<void> => {
      const nickname = (nicknameDrafts[vehicleId] ?? '').trim();
      patchVehicleState(vehicleId, {
        nicknameSaving: true,
        nicknameError: undefined,
        nicknameSuccess: undefined,
      });
      try {
        const res = await fetch('/api/vehicle/nickname', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ vehicleId, nickname }),
        });
        if (!res.ok) {
          throw new Error(await readError(res));
        }
        patchVehicleState(vehicleId, {
          nicknameSaving: false,
          nicknameSuccess: 'Sparat',
          nicknameError: undefined,
        });
        await loadVehicles();
      } catch (error) {
        patchVehicleState(vehicleId, {
          nicknameSaving: false,
          nicknameError: error instanceof Error ? error.message : 'Kunde inte spara nickname',
        });
      }
    },
    [loadVehicles, nicknameDrafts, patchVehicleState],
  );

  const vehicleCards = useMemo(() => {
    if (vehiclesLoading) {
      return <p className="hint">Laddar bilar...</p>;
    }
    if (vehiclesError) {
      return <p className="error-text">{vehiclesError}</p>;
    }
    if (vehicles.length === 0) {
      return <p className="hint">Inga bilar hittades. Tryck "Sync bilar".</p>;
    }

    return vehicles.map((vehicle) => {
      const state = vehicleState[vehicle.id] ?? {};
      const telemetry = state.telemetryData;
      const coords = telemetry?.telemetry ?? null;
      const hasCoords = typeof coords?.lat === 'number' && typeof coords?.lng === 'number';
      const mapsHref = hasCoords ? `https://maps.google.com/?q=${coords.lat},${coords.lng}` : null;

      return (
        <article className="card" key={vehicle.id}>
          <header className="card-header">
            <h2>{vehicle.nickname || 'Min bil'}</h2>
            <p className="meta mono">VIN ••••{vinSuffix(vehicle.vin)}</p>
          </header>

          <p className="meta mono">ID: {vehicle.external_vehicle_id}</p>

          <div className="row">
            <input
              value={nicknameDrafts[vehicle.id] ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                setNicknameDrafts((prev) => ({ ...prev, [vehicle.id]: value }));
              }}
              maxLength={40}
              placeholder="Nickname"
            />
            <button
              onClick={() => void saveNickname(vehicle.id)}
              disabled={state.nicknameSaving || (nicknameDrafts[vehicle.id] ?? '').trim().length === 0}
            >
              {state.nicknameSaving ? 'Sparar...' : 'Spara'}
            </button>
          </div>

          {state.nicknameError ? <p className="error-text">{state.nicknameError}</p> : null}
          {state.nicknameSuccess ? <p className="success-text">{state.nicknameSuccess}</p> : null}

          <div className="button-row">
            <button onClick={() => void wakeVehicle(vehicle.id)} disabled={state.wakeLoading || state.positionLoading}>
              {state.wakeLoading ? 'Väcker...' : 'Wake'}
            </button>
            <button
              onClick={() => void fetchPosition(vehicle.id)}
              disabled={state.positionLoading || state.telemetryLoading}
            >
              {state.positionLoading || state.telemetryLoading ? 'Hämtar...' : 'Hämta position'}
            </button>
          </div>

          {state.wakeError ? <p className="error-text">{state.wakeError}</p> : null}
          {state.wakeMessage ? <p className="hint">{state.wakeMessage}</p> : null}

          <section className="result-panel">
            <h3>Resultat</h3>
            {state.telemetryLoading ? <p className="hint">Hämtar telemetry...</p> : null}
            {state.telemetryError ? <p className="error-text">{state.telemetryError}</p> : null}
            {telemetry ? (
              <div className="result-content">
                <p>
                  Status: <strong>{telemetry.vehicleStatus ?? 'okänd'}</strong>
                </p>
                {hasCoords ? (
                  <>
                    <p className="mono">
                      lat: {telemetry.telemetry?.lat}, lng: {telemetry.telemetry?.lng}
                    </p>
                    <p className="mono">speedKph: {telemetry.telemetry?.speedKph ?? 'null'}</p>
                    <a href={mapsHref ?? '#'} target="_blank" rel="noreferrer">
                      Öppna i Google Maps
                    </a>
                  </>
                ) : (
                  <p className="hint">{telemetry.message ?? 'Ingen position tillgänglig ännu.'}</p>
                )}

                {telemetry.debug ? (
                  <details>
                    <summary>Debug</summary>
                    <pre>{JSON.stringify(telemetry.debug, null, 2)}</pre>
                  </details>
                ) : null}
              </div>
            ) : (
              <p className="hint">Ingen telemetry hämtad ännu.</p>
            )}
          </section>
        </article>
      );
    });
  }, [
    fetchPosition,
    fetchTelemetry,
    loadVehicles,
    nicknameDrafts,
    saveNickname,
    vehicles,
    vehiclesError,
    vehiclesLoading,
    vehicleState,
    wakeVehicle,
  ]);

  return (
    <main className="page-shell">
      <header className="topbar">
        <div>
          <h1>ParkSignal</h1>
          <p className="hint">Dashboard</p>
        </div>
        <button onClick={() => void syncVehicles()} disabled={syncLoading}>
          {syncLoading ? 'Syncar...' : 'Sync bilar'}
        </button>
      </header>

      {syncError ? <p className="error-text">{syncError}</p> : null}
      {syncMessage ? <p className="success-text">{syncMessage}</p> : null}

      <section className="section">
        <h2>Bilar</h2>
        <div className="cards">{vehicleCards}</div>
      </section>
    </main>
  );
}
