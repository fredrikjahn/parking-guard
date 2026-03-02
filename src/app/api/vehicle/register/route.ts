import { getPartnerToken } from '@/lib/tesla/partnerToken';

const TESLA_API_BASE = process.env.TESLA_API_BASE ?? process.env.TESLA_API_BASE_URL;

export async function POST() {
  if (!TESLA_API_BASE) {
    return new Response('Missing TESLA_API_BASE (or TESLA_API_BASE_URL)', { status: 500 });
  }

  const domain = resolveDomain();
  if (!domain) {
    return Response.json(
      {
        ok: false,
        error: 'Missing domain. Set APP_DOMAIN or APP_BASE_URL.',
      },
      { status: 500 },
    );
  }

  let partnerToken: { access_token: string; expires_in: number };
  try {
    partnerToken = await getPartnerToken();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get Tesla partner token';
    return Response.json({ ok: false, error: message }, { status: 500 });
  }

  const registerUrl = `${TESLA_API_BASE}/api/1/partner_accounts`;
  const payloadCandidates: Array<Record<string, unknown>> = [
    { domain },
    { domains: [domain] },
    { allowed_domains: [domain] },
    { allowedDomains: [domain] },
  ];
  const attemptedPayloadKeys: string[] = [];
  let lastErrorText = '';
  let lastStatus = 400;

  for (const payload of payloadCandidates) {
    const key = Object.keys(payload).join(',');
    attemptedPayloadKeys.push(key);

    const res = await fetch(registerUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${partnerToken.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });

    const rawText = await res.text();
    const data = rawText ? safeJsonParse(rawText) : null;

    if (res.ok) {
      return Response.json({
        ok: true,
        endpoint: registerUrl,
        attemptedPayloadKeys,
        token_expires_in: partnerToken.expires_in,
        response: data ?? rawText,
      });
    }

    lastStatus = res.status;
    lastErrorText = rawText;

    if (res.status === 400 && rawText.toLowerCase().includes('domain')) {
      continue;
    }

    return Response.json(
      {
        ok: false,
        error: 'Tesla partner registration failed',
        status: res.status,
        endpoint: registerUrl,
        attemptedPayloadKeys,
        lastErrorText,
        response: data ?? rawText,
      },
      { status: res.status },
    );
  }

  return Response.json(
    {
      ok: false,
      error: 'Tesla partner registration failed for all payload variants',
      status: lastStatus,
      endpoint: registerUrl,
      attemptedPayloadKeys,
      lastErrorText,
    },
    { status: lastStatus },
  );
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function resolveDomain(): string | null {
  const appDomain = process.env.APP_DOMAIN?.trim();
  if (appDomain) {
    return appDomain;
  }

  const appBaseUrl = process.env.APP_BASE_URL?.trim();
  if (!appBaseUrl) {
    return null;
  }

  try {
    return new URL(appBaseUrl).hostname;
  } catch {
    return null;
  }
}
