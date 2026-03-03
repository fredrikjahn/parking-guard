const DEFAULT_STOCKHOLM_LTF_BASE = 'https://openparking.stockholm.se/LTF-Tolken/v1';

function getBaseUrl(): string {
  return process.env.STOCKHOLM_LTF_BASE ?? process.env.STOCKHOLM_BASE_URL ?? DEFAULT_STOCKHOLM_LTF_BASE;
}

function maskApiKey(url: URL): string {
  const masked = new URL(url.toString());
  masked.searchParams.delete('apiKey');
  return masked.toString();
}

export async function GET() {
  const apiKey = process.env.STOCKHOLM_LTF_API_KEY ?? process.env.STOCKHOLM_API_KEY;
  if (!apiKey) {
    return new Response(
      'Missing STOCKHOLM_LTF_API_KEY (or legacy STOCKHOLM_API_KEY) in server environment',
      { status: 500 },
    );
  }

  const base = getBaseUrl().replace(/\/$/, '');
  const url = new URL(`${base}/servicedagar/within`);
  url.searchParams.set('lat', '59.3293');
  url.searchParams.set('lng', '18.0686');
  url.searchParams.set('radius', '50');
  url.searchParams.set('outputFormat', 'json');
  url.searchParams.set('maxFeatures', '5');
  url.searchParams.set('apiKey', apiKey);

  const response = await fetch(url.toString(), {
    method: 'GET',
    cache: 'no-store',
  });

  const bodyText = await response.text();
  if (!response.ok) {
    return Response.json(
      {
        ok: false,
        status: response.status,
        error: bodyText || `Stockholm LTF request failed (${response.status})`,
        urlUsed: maskApiKey(url),
      },
      { status: 502 },
    );
  }

  let parsed: unknown = null;
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as unknown) : null;
  } catch {
    return Response.json(
      {
        ok: false,
        status: response.status,
        error: 'Response was not valid JSON',
        urlUsed: maskApiKey(url),
      },
      { status: 502 },
    );
  }

  const sampleKeys = Object.keys((parsed ?? {}) as Record<string, unknown>);

  return Response.json({
    ok: true,
    status: response.status,
    sampleKeys,
    urlUsed: maskApiKey(url),
  });
}
