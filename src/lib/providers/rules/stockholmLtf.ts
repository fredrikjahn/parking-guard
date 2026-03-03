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

function toStockholmConfig(input: Record<string, unknown>): Required<StockholmConfig> {
  const cfg = input as StockholmConfig;
  return {
    baseUrl: cfg.baseUrl ?? config.STOCKHOLM_LTF_BASE ?? config.STOCKHOLM_BASE_URL,
    apiKeyEnv: cfg.apiKeyEnv ?? 'STOCKHOLM_LTF_API_KEY',
  };
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
    const candidates = ['results', 'items', 'data'];
    for (const key of candidates) {
      const nested = (value as Record<string, unknown>)[key];
      if (Array.isArray(nested)) {
        return nested.length;
      }
    }
  }
  return value ? 1 : 0;
}

export const stockholmLtfProvider: RulesProvider = {
  key: 'stockholm_ltf',

  async rulesWithin({ config: providerConfig, lat, lng, radiusM }: RulesWithinInput): Promise<StockholmRaw> {
    const cfg = toStockholmConfig(providerConfig);
    const apiKey =
      process.env[cfg.apiKeyEnv] ??
      process.env.STOCKHOLM_LTF_API_KEY ??
      process.env.STOCKHOLM_API_KEY;
    if (!apiKey) {
      throw new Error(`Missing API key env var: ${cfg.apiKeyEnv}`);
    }

    const [ptillaten, servicedagar] = await Promise.all([
      callWithin(cfg.baseUrl, 'ptillaten', lat, lng, radiusM, apiKey),
      callWithin(cfg.baseUrl, 'servicedagar', lat, lng, radiusM, apiKey),
    ]);

    return { ptillaten, servicedagar };
  },

  normalize(raw, now): NormalizedRulesResult {
    const parsed = raw as StockholmRaw;

    const ptillatenCount = extractCount(parsed.ptillaten);
    const servicedagarCount = extractCount(parsed.servicedagar);

    const hits: NormalizedRulesResult['hits'] = [];

    if (ptillatenCount > 0) {
      hits.push({
        rule_type: 'ptillaten',
        severity: 'INFO',
        summary: `Found ${ptillatenCount} p-tillaten entries near vehicle`,
        raw: parsed.ptillaten,
      });
    }

    if (servicedagarCount > 0) {
      hits.push({
        rule_type: 'servicedagar',
        severity: 'WARN',
        summary: `Found ${servicedagarCount} servicedagar entries near vehicle`,
        raw: {
          servicedagar: parsed.servicedagar,
          evaluatedAt: now.toISOString(),
          todo: 'Upgrade to CRITICAL when payload indicates service window within 12h.',
        },
      });
    }

    const severity = hits.some((hit) => hit.severity === 'CRITICAL')
      ? 'CRITICAL'
      : hits.some((hit) => hit.severity === 'WARN')
        ? 'WARN'
        : 'INFO';

    return { severity, hits };
  },
};
