import { config } from '@/lib/config';
import type { NormalizedRulesResult, RulesProvider, RulesWithinInput } from './types';

type StockholmRaw = {
  ptillaten: unknown;
  servicedagar: unknown;
};

type StockholmConfig = {
  baseUrl?: string;
  apiKeyEnv?: string;
};

export type StockholmRuleSeverity = 'INFO' | 'WARN' | 'CRITICAL';

export type StockholmNormalizedHit = {
  rule_type: 'servicedagar' | 'ptillaten';
  severity: StockholmRuleSeverity;
  summary: string;
  raw: unknown;
};

export type StockholmNormalizedResult = {
  hits: StockholmNormalizedHit[];
  overallSeverity: StockholmRuleSeverity;
};

function toStockholmConfig(input: Record<string, unknown>): Required<StockholmConfig> {
  const cfg = input as StockholmConfig;
  return {
    baseUrl: cfg.baseUrl ?? config.STOCKHOLM_LTF_BASE ?? config.STOCKHOLM_BASE_URL,
    apiKeyEnv: cfg.apiKeyEnv ?? 'STOCKHOLM_LTF_API_KEY',
  };
}

function resolveStockholmApiKey(apiKeyEnv = 'STOCKHOLM_LTF_API_KEY'): string {
  const apiKey =
    process.env[apiKeyEnv] ??
    process.env.STOCKHOLM_LTF_API_KEY ??
    process.env.STOCKHOLM_API_KEY;
  if (!apiKey) {
    throw new Error(`Missing API key env var: ${apiKeyEnv}`);
  }
  return apiKey;
}

export async function stockholmWithin(input: {
  foreskrift: 'ptillaten' | 'servicedagar';
  lat: number;
  lng: number;
  radiusM: number;
  baseUrl?: string;
  apiKeyEnv?: string;
}): Promise<unknown> {
  const baseUrl = (input.baseUrl ?? config.STOCKHOLM_LTF_BASE ?? config.STOCKHOLM_BASE_URL).replace(/\/$/, '');
  const apiKey = resolveStockholmApiKey(input.apiKeyEnv ?? 'STOCKHOLM_LTF_API_KEY');
  return callWithin(baseUrl, input.foreskrift, input.lat, input.lng, input.radiusM, apiKey);
}

async function callWithin(
  baseUrl: string,
  foreskrift: 'ptillaten' | 'servicedagar',
  lat: number,
  lng: number,
  radiusM: number,
  apiKey: string,
): Promise<unknown> {
  const url = new URL(`${baseUrl}/${foreskrift}/within`);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lng', String(lng));
  url.searchParams.set('radius', String(radiusM));
  url.searchParams.set('outputFormat', 'json');
  url.searchParams.set('apiKey', apiKey);

  const response = await fetch(url.toString(), { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Stockholm LTF ${foreskrift} failed (${response.status})`);
  }

  return response.json();
}

function extractCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value && typeof value === 'object') {
    const candidates = ['features', 'results', 'items', 'data'];
    for (const key of candidates) {
      const nested = (value as Record<string, unknown>)[key];
      if (Array.isArray(nested)) {
        return nested.length;
      }
    }
  }
  return value ? 1 : 0;
}

export function normalizeStockholmWithin(raw: StockholmRaw, now: Date): StockholmNormalizedResult {
  const ptillatenCount = extractCount(raw.ptillaten);
  const servicedagarCount = extractCount(raw.servicedagar);

  const hits: StockholmNormalizedHit[] = [
    {
      rule_type: 'servicedagar',
      severity: servicedagarCount > 0 ? 'WARN' : 'INFO',
      summary:
        servicedagarCount > 0
          ? `Found ${servicedagarCount} servicedagar entries near vehicle`
          : 'No servicedagar entries near vehicle',
      raw: {
        servicedagar: raw.servicedagar,
        evaluatedAt: now.toISOString(),
      },
    },
    {
      rule_type: 'ptillaten',
      severity: 'INFO',
      summary:
        ptillatenCount > 0
          ? `Found ${ptillatenCount} p-tillaten entries near vehicle`
          : 'No p-tillaten entries near vehicle',
      raw: raw.ptillaten,
    },
  ];

  const overallSeverity: StockholmRuleSeverity = hits.some((hit) => hit.severity === 'CRITICAL')
    ? 'CRITICAL'
    : hits.some((hit) => hit.severity === 'WARN')
      ? 'WARN'
      : 'INFO';

  return { hits, overallSeverity };
}

export async function evaluateStockholmWithin(input: {
  lat: number;
  lng: number;
  radiusM: number;
  baseUrl?: string;
  apiKeyEnv?: string;
  now?: Date;
}): Promise<StockholmNormalizedResult> {
  const [ptillaten, servicedagar] = await Promise.all([
    stockholmWithin({
      foreskrift: 'ptillaten',
      lat: input.lat,
      lng: input.lng,
      radiusM: input.radiusM,
      baseUrl: input.baseUrl,
      apiKeyEnv: input.apiKeyEnv,
    }),
    stockholmWithin({
      foreskrift: 'servicedagar',
      lat: input.lat,
      lng: input.lng,
      radiusM: input.radiusM,
      baseUrl: input.baseUrl,
      apiKeyEnv: input.apiKeyEnv,
    }),
  ]);

  return normalizeStockholmWithin({ ptillaten, servicedagar }, input.now ?? new Date());
}

export const stockholmLtfProvider: RulesProvider = {
  key: 'stockholm_ltf',

  async rulesWithin({ config: providerConfig, lat, lng, radiusM }: RulesWithinInput): Promise<StockholmRaw> {
    const cfg = toStockholmConfig(providerConfig);
    const apiKey = resolveStockholmApiKey(cfg.apiKeyEnv);

    const [ptillaten, servicedagar] = await Promise.all([
      callWithin(cfg.baseUrl, 'ptillaten', lat, lng, radiusM, apiKey),
      callWithin(cfg.baseUrl, 'servicedagar', lat, lng, radiusM, apiKey),
    ]);

    return { ptillaten, servicedagar };
  },

  normalize(raw, now): NormalizedRulesResult {
    const parsed = raw as StockholmRaw;
    const normalized = normalizeStockholmWithin(parsed, now);
    const hits = normalized.hits.filter((hit) => {
      if (hit.rule_type === 'servicedagar') {
        return hit.severity === 'WARN' || hit.severity === 'CRITICAL';
      }
      if (hit.rule_type === 'ptillaten') {
        return !hit.summary.startsWith('No p-tillaten');
      }
      return true;
    });

    const severity = hits.some((hit) => hit.severity === 'CRITICAL')
      ? 'CRITICAL'
      : hits.some((hit) => hit.severity === 'WARN')
        ? 'WARN'
        : 'INFO';

    return { severity, hits };
  },
};
