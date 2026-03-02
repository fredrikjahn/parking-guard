import { supabaseAdmin } from '@/lib/db/client';
import { decryptJson } from '@/lib/crypto';

const DEV_USER_ID = process.env.DEV_USER_ID!;

type DecryptedToken = Record<string, unknown> & {
  accessToken?: unknown;
  scope?: unknown;
  expires_in?: unknown;
  raw?: unknown;
};

type DecodedAccessTokenClaims = {
  iss: unknown | null;
  aud: unknown | null;
  exp: unknown | null;
  iat: unknown | null;
  scope: unknown | null;
  scp: unknown | null;
  scopes: unknown | null;
  permissions: unknown | null;
  granted_scopes: unknown | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : `${normalized}${'='.repeat(4 - pad)}`;
  return Buffer.from(padded, 'base64').toString('utf8');
}

function decodeAccessTokenClaims(accessToken: unknown): DecodedAccessTokenClaims | null {
  if (typeof accessToken !== 'string') {
    return null;
  }

  const parts = accessToken.split('.');
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payloadText = decodeBase64Url(parts[1]);
    const payload = JSON.parse(payloadText) as unknown;
    const claims = asObject(payload);
    if (!claims) {
      return null;
    }

    return {
      iss: claims.iss ?? null,
      aud: claims.aud ?? null,
      exp: claims.exp ?? null,
      iat: claims.iat ?? null,
      scope: claims.scope ?? null,
      scp: claims.scp ?? null,
      scopes: claims.scopes ?? null,
      permissions: claims.permissions ?? null,
      granted_scopes: claims.granted_scopes ?? null,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  if (!DEV_USER_ID) return new Response('Missing DEV_USER_ID', { status: 500 });

  const { data: conn, error } = await supabaseAdmin
    .from('vehicle_connections')
    .select('*')
    .eq('user_id', DEV_USER_ID)
    .eq('provider_key', 'tesla_fleet')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return new Response(`DB error: ${error.message}`, { status: 500 });
  if (!conn) return new Response('No active tesla_fleet connection', { status: 404 });

  const token = decryptJson<DecryptedToken>({
    iv: conn.token_iv_b64,
    data: conn.token_data_b64,
  });
  const raw = asObject(token.raw);

  return Response.json({
    ok: true,
    tokenFields: Object.keys(token ?? {}),
    scope: token?.scope ?? null,
    expires_in_present: token?.expires_in ?? null,
    rawKeys: raw ? Object.keys(raw) : [],
    rawScope: raw?.scope ?? raw?.scopes ?? null,
    decodedAccessTokenClaims: decodeAccessTokenClaims(token.accessToken),
  });
}
