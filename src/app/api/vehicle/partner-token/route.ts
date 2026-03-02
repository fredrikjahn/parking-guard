import { getPartnerToken, wasLastPartnerTokenCacheHit } from '@/lib/tesla/partnerToken';

export async function GET() {
  const audience = process.env.TESLA_API_BASE ?? null;
  const hasClientId = Boolean(process.env.TESLA_CLIENT_ID);
  const hasClientSecret = Boolean(process.env.TESLA_CLIENT_SECRET);

  try {
    await getPartnerToken();

    return Response.json({
      ok: true,
      audience,
      hasClientId,
      hasClientSecret,
      cacheHit: wasLastPartnerTokenCacheHit(),
    });
  } catch {
    return Response.json({
      ok: false,
      audience,
      hasClientId,
      hasClientSecret,
      cacheHit: wasLastPartnerTokenCacheHit(),
    });
  }
}
