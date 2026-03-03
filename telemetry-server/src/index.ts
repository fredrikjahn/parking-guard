import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import { RawData, WebSocketServer } from 'ws';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLogLevel(value: string | undefined): LogLevel {
  if (!value) return 'info';
  const normalized = value.toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }
  return 'info';
}

function loadDotEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(eqIndex + 1).trim();
    const startsWithQuote = value.startsWith('"') || value.startsWith("'");
    const endsWithQuote = value.endsWith('"') || value.endsWith("'");
    if (value.length >= 2 && startsWithQuote && endsWithQuote) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadDotEnvFile(resolve(process.cwd(), '.env'));

const config = {
  port: Number.parseInt(process.env.PORT ?? '8080', 10),
  parkSignalBaseUrl: (process.env.PARKSIGNAL_BASE_URL ?? '').replace(/\/$/, ''),
  telemetryIngestSecret: process.env.TELEMETRY_INGEST_SECRET ?? '',
  logLevel: resolveLogLevel(process.env.LOG_LEVEL),
};

if (!config.parkSignalBaseUrl) {
  throw new Error('Missing PARKSIGNAL_BASE_URL');
}

if (!config.telemetryIngestSecret) {
  throw new Error('Missing TELEMETRY_INGEST_SECRET');
}

const logger = {
  debug(message: string, meta?: Record<string, unknown>) {
    if (levelOrder[config.logLevel] <= levelOrder.debug) {
      console.log(`[debug] ${message}`, meta ?? {});
    }
  },
  info(message: string, meta?: Record<string, unknown>) {
    if (levelOrder[config.logLevel] <= levelOrder.info) {
      console.log(`[info] ${message}`, meta ?? {});
    }
  },
  warn(message: string, meta?: Record<string, unknown>) {
    if (levelOrder[config.logLevel] <= levelOrder.warn) {
      console.warn(`[warn] ${message}`, meta ?? {});
    }
  },
  error(message: string, meta?: Record<string, unknown>) {
    if (levelOrder[config.logLevel] <= levelOrder.error) {
      console.error(`[error] ${message}`, meta ?? {});
    }
  },
};

type TelemetryIngestEvent = {
  source: 'tesla';
  vehicleRef: {
    vin?: string;
    externalVehicleId?: string;
  };
  ts: string;
  lat?: number;
  lng?: number;
  speedKph?: number;
  shiftState?: string;
  rawKeys: string[];
};

type ExtractResult = {
  event: TelemetryIngestEvent;
  vehicleKey: string;
};

type Metrics = {
  startedAtMs: number;
  activeConnections: number;
  messagesReceived: number;
  parseErrors: number;
  eventsExtracted: number;
  eventsDropped: number;
  eventsThrottled: number;
  eventsSent: number;
  ingestFailures: number;
};

const metrics: Metrics = {
  startedAtMs: Date.now(),
  activeConnections: 0,
  messagesReceived: 0,
  parseErrors: 0,
  eventsExtracted: 0,
  eventsDropped: 0,
  eventsThrottled: 0,
  eventsSent: 0,
  ingestFailures: 0,
};

const lastSentByVehicle = new Map<string, number>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeTs(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function parseIncomingMessage(raw: RawData): unknown | null {
  try {
    if (typeof raw === 'string') {
      return JSON.parse(raw) as unknown;
    }
    if (Buffer.isBuffer(raw)) {
      return JSON.parse(raw.toString('utf8')) as unknown;
    }
    if (Array.isArray(raw)) {
      return JSON.parse(Buffer.concat(raw).toString('utf8')) as unknown;
    }
    return JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function extractEvent(message: unknown): ExtractResult | null {
  const msg = asRecord(message);
  if (!msg) {
    return null;
  }

  const vehicleObj = asRecord(msg.vehicle);
  const vehicleRefObj = asRecord(msg.vehicle_ref);
  const position = asRecord(msg.position);

  const vin = asString(msg.vin) ?? asString(vehicleObj?.vin) ?? asString(vehicleRefObj?.vin);
  const externalVehicleId =
    asString(msg.vehicle_id) ?? asString(msg.vehicleId) ?? asString(vehicleObj?.id);

  const ts = normalizeTs(msg.ts ?? msg.timestamp);
  const lat = asNumber(msg.lat) ?? asNumber(msg.latitude) ?? asNumber(position?.lat);
  const lng = asNumber(msg.lng) ?? asNumber(msg.longitude) ?? asNumber(position?.lng);
  const speedKph = asNumber(msg.speed) ?? asNumber(msg.speed_kph) ?? asNumber(msg.speedKph);
  const shiftState = asString(msg.shift_state) ?? asString(msg.shiftState);
  const rawKeys = Object.keys(msg);

  const vehicleKey = vin ?? externalVehicleId;
  const hasTelemetryValue =
    typeof lat === 'number' ||
    typeof lng === 'number' ||
    typeof speedKph === 'number' ||
    typeof shiftState === 'string';

  if (!vehicleKey || !hasTelemetryValue) {
    return null;
  }

  const event: TelemetryIngestEvent = {
    source: 'tesla',
    vehicleRef: {
      ...(vin ? { vin } : {}),
      ...(externalVehicleId ? { externalVehicleId } : {}),
    },
    ts,
    ...(typeof lat === 'number' ? { lat } : {}),
    ...(typeof lng === 'number' ? { lng } : {}),
    ...(typeof speedKph === 'number' ? { speedKph } : {}),
    ...(typeof shiftState === 'string' ? { shiftState } : {}),
    rawKeys,
  };

  return { event, vehicleKey };
}

function shouldThrottle(vehicleKey: string): boolean {
  const now = Date.now();
  const last = lastSentByVehicle.get(vehicleKey) ?? 0;
  if (now - last < 1000) {
    return true;
  }
  lastSentByVehicle.set(vehicleKey, now);
  return false;
}

async function postToParkSignal(event: TelemetryIngestEvent): Promise<{ ok: boolean; retryable: boolean }> {
  const url = `${config.parkSignalBaseUrl}/api/telemetry/ingest`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telemetry-secret': config.telemetryIngestSecret,
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });

    if (res.ok) {
      return { ok: true, retryable: false };
    }

    const retryable = res.status >= 500;
    const text = await res.text().catch(() => '');
    logger.warn('Ingest returned non-2xx', {
      status: res.status,
      retryable,
      responseText: text.slice(0, 280),
    });
    return { ok: false, retryable };
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    logger.warn('Ingest request failed', {
      isAbort,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, retryable: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendWithRetry(event: TelemetryIngestEvent): Promise<boolean> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await postToParkSignal(event);
    if (result.ok) {
      return true;
    }
    if (!result.retryable || attempt === maxAttempts) {
      return false;
    }
    const backoffMs = 200 * 2 ** (attempt - 1);
    await sleep(backoffMs);
  }
  return false;
}

const app = express();

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.floor((Date.now() - metrics.startedAtMs) / 1000),
    activeConnections: metrics.activeConnections,
  });
});

app.get('/metrics', (_req, res) => {
  const uptimeSec = Math.floor((Date.now() - metrics.startedAtMs) / 1000);
  const lines = [
    `uptime_seconds ${uptimeSec}`,
    `active_connections ${metrics.activeConnections}`,
    `messages_received_total ${metrics.messagesReceived}`,
    `messages_parse_errors_total ${metrics.parseErrors}`,
    `events_extracted_total ${metrics.eventsExtracted}`,
    `events_dropped_total ${metrics.eventsDropped}`,
    `events_throttled_total ${metrics.eventsThrottled}`,
    `events_sent_total ${metrics.eventsSent}`,
    `ingest_failures_total ${metrics.ingestFailures}`,
  ];
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n'));
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (socket, req) => {
  metrics.activeConnections += 1;
  logger.info('WS connected', { remoteAddress: req.socket.remoteAddress, active: metrics.activeConnections });

  socket.on('message', async (data) => {
    metrics.messagesReceived += 1;

    const parsed = parseIncomingMessage(data);
    if (!parsed) {
      metrics.parseErrors += 1;
      logger.debug('Dropped message: parse error');
      return;
    }

    const extracted = extractEvent(parsed);
    if (!extracted) {
      metrics.eventsDropped += 1;
      logger.debug('Dropped message: no relevant fields');
      return;
    }

    metrics.eventsExtracted += 1;
    if (shouldThrottle(extracted.vehicleKey)) {
      metrics.eventsThrottled += 1;
      return;
    }

    const sent = await sendWithRetry(extracted.event);
    if (sent) {
      metrics.eventsSent += 1;
    } else {
      metrics.ingestFailures += 1;
    }
  });

  socket.on('close', () => {
    metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
    logger.info('WS disconnected', { active: metrics.activeConnections });
  });

  socket.on('error', (error) => {
    logger.warn('WS socket error', { message: error.message });
  });
});

server.listen(config.port, () => {
  logger.info('Telemetry server started', {
    port: config.port,
    ingestUrl: `${config.parkSignalBaseUrl}/api/telemetry/ingest`,
  });
});
