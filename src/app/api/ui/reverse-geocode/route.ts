import { z } from 'zod';

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

type NominatimResponse = {
  display_name?: string;
  name?: string;
  address?: Record<string, string>;
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({
    lat: searchParams.get('lat'),
    lng: searchParams.get('lng'),
  });

  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(parsed.data.lat));
  url.searchParams.set('lon', String(parsed.data.lng));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('addressdetails', '1');

  const res = await fetch(url.toString(), {
    cache: 'no-store',
    headers: {
      'user-agent': 'ParkSignal/0.1 (reverse-geocode)',
      accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return new Response(`Reverse geocode failed: ${res.status} ${text}`, { status: 502 });
  }

  const json = (await res.json()) as NominatimResponse;
  const displayName = json.display_name ?? null;

  return Response.json({
    ok: true,
    provider: 'nominatim',
    lat: parsed.data.lat,
    lng: parsed.data.lng,
    address: displayName,
    name: json.name ?? null,
  });
}
