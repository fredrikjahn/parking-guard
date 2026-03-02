type PartnerTokenApiResponse = {
  access_token?: unknown;
  expires_in?: unknown;
};

type PartnerToken = {
  access_token: string;
  expires_in: number;
};

type CachedPartnerToken = {
  token: PartnerToken;
  expiresAtMs: number;
};

const TESLA_PARTNER_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const CACHE_TTL_MS = 50 * 60 * 1000;
const tokenCache = new Map<string, CachedPartnerToken>();
let lastCacheHit = false;

export function wasLastPartnerTokenCacheHit(): boolean {
  return lastCacheHit;
}

export async function getPartnerToken(audienceBase?: string): Promise<PartnerToken> {
  const audience = process.env.TESLA_PARTNER_AUDIENCE ?? audienceBase ?? process.env.TESLA_API_BASE;
  if (!audience) {
    throw new Error('Missing TESLA_PARTNER_AUDIENCE (or audienceBase/TESLA_API_BASE)');
  }

  const now = Date.now();
  const cachedToken = tokenCache.get(audience);
  if (cachedToken && cachedToken.expiresAtMs > now) {
    lastCacheHit = true;
    return cachedToken.token;
  }
  lastCacheHit = false;

  const clientId = process.env.TESLA_CLIENT_ID;
  const clientSecret = process.env.TESLA_CLIENT_SECRET;

  if (!clientId) {
    throw new Error('Missing TESLA_CLIENT_ID');
  }
  if (!clientSecret) {
    throw new Error('Missing TESLA_CLIENT_SECRET');
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    audience,
  });

  const res = await fetch(TESLA_PARTNER_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    cache: 'no-store',
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Tesla partner token failed: ${res.status} ${rawText}`);
  }

  const parsed = safeJsonParse(rawText) as PartnerTokenApiResponse | null;
  if (!parsed || typeof parsed.access_token !== 'string') {
    throw new Error('Tesla partner token response missing access_token');
  }

  const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3000;

  const token: PartnerToken = {
    access_token: parsed.access_token,
    expires_in: expiresIn,
  };

  tokenCache.set(audience, {
    token,
    expiresAtMs: now + CACHE_TTL_MS,
  });

  return token;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
