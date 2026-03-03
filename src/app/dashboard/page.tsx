'use client';

import { useCallback, useEffect, useState } from 'react';
import WeekSchedule from './WeekSchedule';

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

type VehicleCardEvent = {
  id: string;
  type: string;
  ts: string;
  lat: number | string | null;
  lng: number | string | null;
  speed_kph: number | string | null;
  shift_state: string | null;
  meta: Record<string, unknown>;
};

type WeekScheduleModel = Array<{
  day: 'Mån' | 'Tis' | 'Ons' | 'Tor' | 'Fre' | 'Lör' | 'Sön';
  rows: Array<{
    from: string;
    to: string;
    label: string;
  }>;
}>;

type AddressTestResponse = {
  ok: boolean;
  queryAddress: string;
  resolvedAddress: string;
  selectedRuleAddress: string | null;
  location: {
    lat: number;
    lng: number;
  };
  activeSegment: {
    ruleType: 'servicedagar' | 'ptillaten';
    address: string | null;
    citation: string | null;
    placeType: string | null;
    vehicle: string | null;
    dayIndexes: number[];
    startMin: number | null;
    endMin: number | null;
    windowText: string | null;
    activeNow: boolean;
    blocksPassengerCarNow: boolean;
    distanceM: number | null;
  } | null;
  lastplats: {
    isLastplats: boolean;
    evidenceCount: number;
    addresses: string[];
    placeTypes: string[];
    vehicles: string[];
  };
  ruleHits: Array<{
    type: 'servicedagar' | 'ptillaten';
    severity: string;
    count: number;
    short: string;
    lines: string[];
  }>;
  weeklySchedule: WeekScheduleModel;
  debug: {
    servicedagarFeatures: number;
    ptillatenFeatures: number;
  };
};

type VehicleCardModel = {
  vehicle: {
    id: string;
    nickname: string;
    vinSuffix: string;
  };
  latestTelemetry: {
    ts: string;
    lat: number | null;
    lng: number | null;
    speed_kph: number | null;
    shift_state: string | null;
  } | null;
  latestEvents: VehicleCardEvent[];
  parkedCard: {
    eventId: string;
    ts: string;
    checkedAt: string;
    address: string | null;
    lat: number | null;
    lng: number | null;
    statusSummary: {
      statusNow: 'OK' | 'FORBIDDEN' | 'UNKNOWN';
      headline: string;
      recommendation: string;
      nextRisk: {
        type: 'SERVICEDAY' | 'TIME_LIMIT' | 'FEE';
        startsAt: string;
        endsAt: string;
        message: string;
      } | null;
      nextRiskText: string | null;
      nextActionAt?: string | null;
      servicedayText: string | null;
      allowedText: string | null;
      feeText: string | null;
      boendeText: string | null;
    };
    ruleHits: Array<{
      severity: string;
      title: string;
      shortText: string;
      rawJson: unknown;
    }>;
    allParkingRules: Array<{
      title: string;
      severity: string;
      summary: string;
    }>;
    ruleOverview: {
      forbidden: string[];
      paid: string[];
      free: string[];
    };
    weeklySchedule: WeekScheduleModel;
    debugRuleHits: Array<{
      severity: string;
      rule_type: string;
      summary: string;
      raw_json: unknown;
    }>;
  } | null;
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
  cardLoading?: boolean;
  cardError?: string;
  cardData?: VehicleCardModel;
  showParkedDetails?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatTs(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return value;
  }

  return new Date(ms).toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Europe/Stockholm',
  });
}

function statusClass(status: 'OK' | 'FORBIDDEN' | 'UNKNOWN'): string {
  if (status === 'FORBIDDEN') return 'status-badge status-forbidden';
  if (status === 'UNKNOWN') return 'status-badge status-risk';
  return 'status-badge status-ok';
}

function statusLabel(status: 'OK' | 'FORBIDDEN' | 'UNKNOWN'): string {
  if (status === 'FORBIDDEN') return 'FORBJUDEN';
  if (status === 'UNKNOWN') return 'OKÄND';
  return 'OK NU';
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

function formatUserError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('token expired')) {
    return 'Tesla-sessionen har gått ut. Kör /api/vehicle/oauth/start för att koppla om bilen.';
  }
  return message;
}

export default function DashboardPage() {
  const [vehicles, setVehicles] = useState<UiVehicle[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(true);
  const [vehiclesError, setVehiclesError] = useState<string | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [cardsRefreshLoading, setCardsRefreshLoading] = useState(false);
  const [addressTestInput, setAddressTestInput] = useState('Rådmansgatan 12A, Stockholm');
  const [addressTestLoading, setAddressTestLoading] = useState(false);
  const [addressTestError, setAddressTestError] = useState<string | null>(null);
  const [addressTestResult, setAddressTestResult] = useState<AddressTestResponse | null>(null);
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

  const fetchVehicleCard = useCallback(
    async (vehicleId: string, silent = false): Promise<void> => {
      patchVehicleState(vehicleId, {
        cardLoading: !silent,
        ...(silent ? {} : { cardError: undefined }),
      });

      try {
        const res = await fetch(`/api/ui/vehicle-card?vehicleId=${encodeURIComponent(vehicleId)}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          throw new Error(await readError(res));
        }
        const json = (await res.json()) as VehicleCardModel;
        patchVehicleState(vehicleId, {
          cardLoading: false,
          cardError: undefined,
          cardData: json,
        });
      } catch (error) {
        patchVehicleState(vehicleId, {
          cardLoading: false,
          cardError: error instanceof Error ? error.message : 'Kunde inte hämta parkeringsstatus',
        });
      }
    },
    [patchVehicleState],
  );

  const loadVehicles = useCallback(async () => {
    setVehiclesLoading(true);
    setVehiclesError(null);

    try {
      const res = await fetch('/api/ui/vehicles', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(await readError(res));
      }

      const json = (await res.json()) as unknown;
      const list = Array.isArray(json) ? (json as UiVehicle[]) : [];
      const filteredVehicles = list.filter(
        (vehicle) => vehicle.id !== 'dev-vehicle-1' && vehicle.external_vehicle_id !== 'dev-vehicle-1',
      );

      setVehicles(filteredVehicles);
      setNicknameDrafts((prev) => {
        const next: Record<string, string> = {};
        for (const vehicle of filteredVehicles) {
          next[vehicle.id] = prev[vehicle.id] ?? vehicle.nickname ?? '';
        }
        return next;
      });

      await Promise.all(filteredVehicles.map((vehicle) => fetchVehicleCard(vehicle.id, true)));
    } catch (error) {
      setVehiclesError(error instanceof Error ? error.message : 'Kunde inte hämta bilar');
    } finally {
      setVehiclesLoading(false);
    }
  }, [fetchVehicleCard]);

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
      setSyncMessage(
        `Sync klar${typeof json?.synced === 'number' ? ` (${json.synced} bil${json.synced === 1 ? '' : 'ar'})` : ''}.`,
      );
      await loadVehicles();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Sync misslyckades');
    } finally {
      setSyncLoading(false);
    }
  }, [loadVehicles]);

  const refreshCards = useCallback(async () => {
    setCardsRefreshLoading(true);
    try {
      await Promise.all(vehicles.map((vehicle) => fetchVehicleCard(vehicle.id, false)));
    } finally {
      setCardsRefreshLoading(false);
    }
  }, [fetchVehicleCard, vehicles]);

  const runAddressTest = useCallback(async () => {
    const address = addressTestInput.trim();
    if (!address) {
      setAddressTestError('Ange en adress.');
      return;
    }

    setAddressTestLoading(true);
    setAddressTestError(null);
    try {
      const res = await fetch(`/api/ui/address-test?address=${encodeURIComponent(address)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(await readError(res));
      }
      const json = (await res.json()) as AddressTestResponse;
      setAddressTestResult(json);
    } catch (error) {
      setAddressTestError(error instanceof Error ? error.message : 'Kunde inte testa adress');
      setAddressTestResult(null);
    } finally {
      setAddressTestLoading(false);
    }
  }, [addressTestInput]);

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
        const json = (await res.json().catch(() => null)) as { response?: { state?: string } } | null;
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
        await fetchVehicleCard(vehicleId, true);
      } catch (error) {
        patchVehicleState(vehicleId, {
          telemetryLoading: false,
          telemetryError: error instanceof Error ? error.message : 'Telemetry misslyckades',
        });
      }
    },
    [fetchVehicleCard, patchVehicleState],
  );

  const fetchPosition = useCallback(
    async (vehicleId: string): Promise<void> => {
      patchVehicleState(vehicleId, { positionLoading: true });
      try {
        await wakeVehicle(vehicleId, true);
        await sleep(1500);
        await fetchTelemetry(vehicleId);
        await fetchVehicleCard(vehicleId, true);
      } finally {
        patchVehicleState(vehicleId, { positionLoading: false });
      }
    },
    [fetchTelemetry, fetchVehicleCard, patchVehicleState, wakeVehicle],
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

  return (
    <main className="page-shell">
      <header className="topbar">
        <div>
          <h1>ParkSignal</h1>
          <p className="hint">Dashboard</p>
        </div>

        <div className="button-row">
          <button onClick={() => void syncVehicles()} disabled={syncLoading}>
            {syncLoading ? 'Syncar...' : 'Sync bilar'}
          </button>
          <button onClick={() => void refreshCards()} disabled={cardsRefreshLoading || vehicles.length === 0}>
            {cardsRefreshLoading ? 'Uppdaterar...' : 'Uppdatera status'}
          </button>
        </div>
      </header>

      {syncError ? <p className="error-text">{syncError}</p> : null}
      {syncMessage ? <p className="success-text">{syncMessage}</p> : null}

      <section className="section">
        <h2>Adress-test</h2>
        <p className="hint">Testa en adress och se om regler/scheman matchar förväntat.</p>
        <div className="card">
          <div className="row">
            <input
              value={addressTestInput}
              onChange={(event) => setAddressTestInput(event.target.value)}
              placeholder="Ex: Rådmansgatan 12A, Stockholm"
            />
            <button onClick={() => void runAddressTest()} disabled={addressTestLoading}>
              {addressTestLoading ? 'Testar...' : 'Testa adress'}
            </button>
          </div>

          {addressTestError ? <p className="error-text">{addressTestError}</p> : null}

          {addressTestResult ? (
            <div className="result-panel">
              <p className="meta">
                <strong>Matchad adress:</strong> {addressTestResult.selectedRuleAddress ?? addressTestResult.resolvedAddress}
              </p>
              <p className="meta">
                <strong>Koordinater:</strong> {addressTestResult.location.lat.toFixed(6)}, {addressTestResult.location.lng.toFixed(6)}
              </p>
              <p className="meta">
                <strong>Lastplats:</strong> {addressTestResult.lastplats.isLastplats ? 'Ja' : 'Nej'}
                {addressTestResult.lastplats.isLastplats ? (
                  <>
                    {' '}
                    {addressTestResult.lastplats.addresses.length > 0
                      ? `(${addressTestResult.lastplats.addresses.join(', ')})`
                      : ''}
                    {addressTestResult.lastplats.placeTypes.length > 0
                      ? ` Typ: ${addressTestResult.lastplats.placeTypes.join(', ')}`
                      : ''}
                  </>
                ) : null}
              </p>
              {addressTestResult.activeSegment ? (
                <p className="meta">
                  <strong>Aktivt segment:</strong>{' '}
                  {addressTestResult.activeSegment.address ?? 'okänt segment'}
                  {addressTestResult.activeSegment.placeType ? ` • ${addressTestResult.activeSegment.placeType}` : ''}
                  {addressTestResult.activeSegment.windowText ? ` • tid: ${addressTestResult.activeSegment.windowText}` : ''}
                  {addressTestResult.activeSegment.distanceM !== null
                    ? ` • ${addressTestResult.activeSegment.distanceM.toFixed(1)} m`
                    : ''}
                  {addressTestResult.activeSegment.blocksPassengerCarNow ? ' • blockerar personbil nu' : ''}
                </p>
              ) : null}

              <div className="rules-summary-box">
                <p className="meta">
                  <strong>Regelträffar</strong>
                </p>
                {addressTestResult.ruleHits.map((hit, index) => (
                  <p className="meta" key={`address-test-hit-${index}`}>
                    <strong>{hit.type === 'servicedagar' ? 'Gatusopning' : 'Tillåten parkering'}:</strong> {hit.short}{' '}
                    <span className="hint">({hit.count} träffar)</span>
                  </p>
                ))}
              </div>

              <div className="rules-summary-box">
                <p className="meta">
                  <strong>Veckoschema (test)</strong>
                </p>
                <WeekSchedule schedule={addressTestResult.weeklySchedule} />
              </div>

              <details>
                <summary>Debug</summary>
                <pre>{JSON.stringify(addressTestResult, null, 2)}</pre>
              </details>
            </div>
          ) : null}
        </div>
      </section>

      <section className="section">
        <h2>Bilar</h2>

        {vehiclesLoading ? <p className="hint">Laddar bilar...</p> : null}
        {vehiclesError ? <p className="error-text">{vehiclesError}</p> : null}
        {!vehiclesLoading && !vehiclesError && vehicles.length === 0 ? (
          <p className="hint">Inga bilar hittades. Tryck "Sync bilar".</p>
        ) : null}

        <div className="cards">
          {vehicles.map((vehicle) => {
            const state = vehicleState[vehicle.id] ?? {};
            const cardData = state.cardData;
            const parkedCard = cardData?.parkedCard ?? null;
            const mapsHref =
              parkedCard && parkedCard.lat !== null && parkedCard.lng !== null
                ? `https://maps.google.com/?q=${parkedCard.lat},${parkedCard.lng}`
                : null;

            return (
              <article className="card" key={vehicle.id}>
                <header className="card-header">
                  <h2>{vehicle.nickname || 'Min bil'}</h2>
                  <p className="meta mono">VIN ••••{cardData?.vehicle.vinSuffix ?? 'okand'}</p>
                </header>

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

                <section className="result-panel">
                  <h3>Parkeringsstatus</h3>

                  {state.cardLoading ? <p className="hint">Hämtar status...</p> : null}
                  {state.cardError ? <p className="error-text">{state.cardError}</p> : null}

                  {!state.cardLoading && !state.cardError && parkedCard ? (
                    <div className="parking-status-block">
                      <div className="parking-status-head">
                        <span className={statusClass(parkedCard.statusSummary.statusNow)}>
                          {statusLabel(parkedCard.statusSummary.statusNow)}
                        </span>
                        <span className="event-ts mono">Kontrollerad: {formatTs(parkedCard.checkedAt)}</span>
                      </div>

                      <p className="status-headline">{parkedCard.statusSummary.headline}</p>
                      <p className="status-recommendation">{parkedCard.statusSummary.recommendation}</p>
                      {parkedCard.statusSummary.nextRiskText ? (
                        <p className="meta">
                          <strong>Nästa risk:</strong> {parkedCard.statusSummary.nextRiskText}
                        </p>
                      ) : null}

                      <p className="meta">
                        <strong>Adress:</strong> {parkedCard.address ?? 'Adress saknas'}
                        {mapsHref ? (
                          <>
                            {' '}
                            <a href={mapsHref} target="_blank" rel="noreferrer">
                              Visa på karta
                            </a>
                          </>
                        ) : null}
                      </p>

                      {parkedCard.statusSummary.nextActionAt ? (
                        <p className="hint">Föreslagen ny kontroll: {formatTs(parkedCard.statusSummary.nextActionAt)}</p>
                      ) : null}

                      <button
                        onClick={() =>
                          patchVehicleState(vehicle.id, {
                            showParkedDetails: !state.showParkedDetails,
                          })
                        }
                      >
                        {state.showParkedDetails ? 'Dölj detaljer' : 'Visa detaljer'}
                      </button>

                      {state.showParkedDetails ? (
                        <div className="status-details">
                          <div className="rules-summary-box">
                            <p className="meta"><strong>Regler</strong></p>
                            <p className="meta">
                              <strong>Gatusopning:</strong>{' '}
                              {parkedCard.statusSummary.servicedayText
                                ? `${parkedCard.statusSummary.servicedayText} (parkeringsförbud)`
                                : 'Ingen servicedag hittades.'}
                            </p>
                            <p className="meta">
                              <strong>Tillåten parkering:</strong>{' '}
                              {parkedCard.statusSummary.allowedText ?? 'Ingen tillåten tidsrad hittades.'}
                            </p>
                            <p className="meta">
                              <strong>Avgift:</strong>{' '}
                              {parkedCard.statusSummary.feeText ?? 'Taxa saknas i underlaget.'}
                            </p>
                            {parkedCard.statusSummary.boendeText ? (
                              <p className="meta"><strong>Boende:</strong> {parkedCard.statusSummary.boendeText}</p>
                            ) : null}
                          </div>

                          <div className="rules-summary-box">
                            <p className="meta">
                              <strong>Veckoschema</strong>
                            </p>
                            <WeekSchedule schedule={parkedCard.weeklySchedule} />
                          </div>

                          <details>
                            <summary>Rådata (debug)</summary>
                            <pre>{JSON.stringify(parkedCard.debugRuleHits, null, 2)}</pre>
                          </details>

                          <button onClick={() => void fetchVehicleCard(vehicle.id, false)}>Uppdatera regelträffar</button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {!state.cardLoading && !state.cardError && !parkedCard ? (
                    <p className="hint">Ingen aktiv PARKED-händelse ännu.</p>
                  ) : null}
                </section>

                <details className="advanced-box">
                  <summary>Avancerat</summary>

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
                    <button onClick={() => void fetchTelemetry(vehicle.id)} disabled={state.telemetryLoading}>
                      {state.telemetryLoading ? 'Laddar...' : 'Hämta telemetry'}
                    </button>
                  </div>

                  {state.wakeError ? <p className="error-text">{formatUserError(state.wakeError)}</p> : null}
                  {state.wakeMessage ? <p className="hint">{state.wakeMessage}</p> : null}

                  {state.telemetryError ? <p className="error-text">{formatUserError(state.telemetryError)}</p> : null}
                  {state.telemetryData ? <pre>{JSON.stringify(state.telemetryData, null, 2)}</pre> : null}

                  {(cardData?.latestEvents ?? []).length > 0 ? (
                    <div className="result-panel">
                      <h3>Senaste events</h3>
                      {(cardData?.latestEvents ?? []).slice(0, 5).map((event) => (
                        <p className="meta mono" key={event.id}>
                          {event.type} {formatTs(event.ts)} lat={event.lat ?? '-'} lng={event.lng ?? '-'}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </details>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
