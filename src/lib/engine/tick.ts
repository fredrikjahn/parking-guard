import { config } from '@/lib/config';
import { decryptJson, encryptJson } from '@/lib/crypto';
import {
  type NotificationKind,
  type ParkingEventStatus,
  type RuleSeverity,
  repo,
} from '@/lib/db/repo';
import { evaluateRulesForPoint } from '@/lib/engine/ruleEvaluator';
import { resolveRulesSourcesForPosition } from '@/lib/engine/jurisdictionResolver';
import { detectParked, type DetectorSample } from '@/lib/engine/parkedDetector';
import { notifyParkingEvent } from '@/lib/notify/notifier';
import { getVehicleProvider } from '@/lib/providers/vehicles';
import type { VehicleTokenPayload } from '@/lib/providers/vehicles/types';

const rulesCheckCache = new Map<string, number>();

function shouldCheckRules(eventId: string): boolean {
  const now = Date.now();
  const last = rulesCheckCache.get(eventId);
  if (last && now - last < config.RULES_CHECK_TTL_SECONDS * 1000) {
    return false;
  }

  rulesCheckCache.set(eventId, now);
  return true;
}

function parseSamples(raw: unknown): DetectorSample[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const value = entry as Record<string, unknown>;
      if (
        typeof value.lat !== 'number' ||
        typeof value.lng !== 'number' ||
        typeof value.speedKph !== 'number' ||
        typeof value.at !== 'string'
      ) {
        return null;
      }
      return {
        lat: value.lat,
        lng: value.lng,
        speedKph: value.speedKph,
        at: value.at,
      };
    })
    .filter((entry): entry is DetectorSample => entry !== null);
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) {
    return false;
  }
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) {
    return false;
  }
  return ms - Date.now() < 60_000;
}

async function maybeSendNotification(input: {
  parkingEventId: string;
  userId: string;
  summary: string;
  kind: NotificationKind;
}) {
  const alreadySent = await repo.hasNotificationKind(input.parkingEventId, input.kind);
  if (alreadySent) {
    return false;
  }

  await notifyParkingEvent({
    userId: input.userId,
    parkingEventId: input.parkingEventId,
    kind: input.kind,
    summary: input.summary,
  });

  await repo.logNotification({
    parking_event_id: input.parkingEventId,
    kind: input.kind,
    sent_at: new Date().toISOString(),
    user_action: null,
  });

  return true;
}

function shouldNotify(severity: RuleSeverity): boolean {
  return severity === 'WARN' || severity === 'CRITICAL';
}

export async function runTick() {
  const { connection, vehicle } = await repo.getActiveConnectionAndVehicleForUser(config.DEV_USER_ID);

  if (!connection || !vehicle) {
    return {
      processed: false,
      reason: 'No active connection/vehicle for dev user',
    };
  }

  const provider = getVehicleProvider(connection.provider_key);
  if (!provider) {
    throw new Error(`Unknown vehicle provider: ${connection.provider_key}`);
  }

  let token = decryptJson<VehicleTokenPayload>({
    iv: connection.token_iv_b64,
    data: connection.token_data_b64,
  });

  if (isExpired(token.expiresAt)) {
    if (!token.refreshToken) {
      throw new Error('Access token expired and no refresh token available');
    }

    token = await provider.refreshToken(token.refreshToken);
    const encrypted = encryptJson(token);
    await repo.updateVehicleConnectionToken(connection.id, {
      token_iv_b64: encrypted.iv,
      token_data_b64: encrypted.data,
      expires_at: token.expiresAt ?? null,
    });
  }

  const telemetry = await provider.getTelemetrySample(token.accessToken, vehicle.external_vehicle_id);
  const now = new Date();
  const nowIso = now.toISOString();
  const currentSample: DetectorSample = {
    ...telemetry,
    at: nowIso,
  };

  let event = await repo.getOpenParkingEvent(vehicle.id);
  if (!event) {
    const created = await repo.createParkingEvent({
      user_id: config.DEV_USER_ID,
      vehicle_id: vehicle.id,
      started_at: nowIso,
      last_seen_at: nowIso,
      lat: currentSample.lat,
      lng: currentSample.lng,
      status: 'MOVING',
      raw_samples: [currentSample],
    });

    return {
      processed: true,
      eventId: created.id,
      status: created.status,
      rulesChecked: false,
      notifications: [],
    };
  }

  const history = parseSamples(event.raw_samples);
  const samples = [...history, currentSample].slice(-300);

  const parkedNow = detectParked({
    samples,
    stillMinutes: config.STILL_MINUTES,
    maxDriftM: config.MAX_DRIFT_M,
    now,
  });

  let nextStatus = event.status as ParkingEventStatus;
  let startedAt = event.started_at as string;

  if (nextStatus === 'MOVING' && parkedNow) {
    nextStatus = 'PARKED';
    startedAt = nowIso;
  } else if (nextStatus === 'PARKED' && !parkedNow && currentSample.speedKph > 5) {
    nextStatus = 'ENDED';
  }

  event = await repo.updateParkingEvent(event.id, {
    started_at: startedAt,
    last_seen_at: nowIso,
    lat: currentSample.lat,
    lng: currentSample.lng,
    status: nextStatus,
    raw_samples: samples,
  });

  if (nextStatus === 'ENDED') {
    await repo.createParkingEvent({
      user_id: config.DEV_USER_ID,
      vehicle_id: vehicle.id,
      started_at: nowIso,
      last_seen_at: nowIso,
      lat: currentSample.lat,
      lng: currentSample.lng,
      status: 'MOVING',
      raw_samples: [currentSample],
    });

    return {
      processed: true,
      eventId: event.id,
      status: nextStatus,
      rulesChecked: false,
      notifications: [],
    };
  }

  let rulesChecked = false;
  let severity: RuleSeverity = 'INFO';
  let hitCount = 0;
  const notifications: NotificationKind[] = [];

  if (nextStatus === 'PARKED' && shouldCheckRules(event.id)) {
    rulesChecked = true;

    const resolved = await resolveRulesSourcesForPosition(currentSample.lat, currentSample.lng);
    const evaluation = await evaluateRulesForPoint({
      lat: currentSample.lat,
      lng: currentSample.lng,
      radiusM: config.DEFAULT_RADIUS_M,
      rulesSources: resolved.rulesSources,
    });

    severity = evaluation.severity;
    hitCount = evaluation.hits.length;

    if (evaluation.hits.length > 0) {
      await repo.insertRuleHits(
        evaluation.hits.map((hit) => ({
          parking_event_id: event.id,
          rules_source_id: hit.rules_source_id,
          rule_type: hit.rule_type,
          severity: hit.severity,
          summary: hit.summary,
          raw_json: hit.raw_json,
        })),
      );
    }

    const parkedMinutes = (Date.now() - Date.parse(event.started_at as string)) / 60_000;

    if (shouldNotify(severity)) {
      if (parkedMinutes >= config.HARD_DELAY_MIN) {
        const sent = await maybeSendNotification({
          parkingEventId: event.id,
          userId: config.DEV_USER_ID,
          kind: 'HARD',
          summary: `Severity ${severity}. ${hitCount} active rule hit(s).`,
        });
        if (sent) {
          notifications.push('HARD');
        }
      } else if (parkedMinutes >= config.SOFT_DELAY_MIN) {
        const sent = await maybeSendNotification({
          parkingEventId: event.id,
          userId: config.DEV_USER_ID,
          kind: 'SOFT',
          summary: `Severity ${severity}. ${hitCount} active rule hit(s).`,
        });
        if (sent) {
          notifications.push('SOFT');
        }
      }
    }
  }

  return {
    processed: true,
    eventId: event.id,
    status: nextStatus,
    rulesChecked,
    severity,
    hitCount,
    notifications,
  };
}
