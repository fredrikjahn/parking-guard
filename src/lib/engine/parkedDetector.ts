export type DetectorSample = {
  lat: number;
  lng: number;
  speedKph: number;
  at: string;
};

type DetectParkedInput = {
  samples: DetectorSample[];
  stillMinutes: number;
  maxDriftM: number;
  now?: Date;
};

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const earthRadiusM = 6371000;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  const y = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));

  return earthRadiusM * y;
}

export function detectParked({ samples, stillMinutes, maxDriftM, now = new Date() }: DetectParkedInput): boolean {
  if (samples.length < 2) {
    return false;
  }

  const windowStart = now.getTime() - stillMinutes * 60_000;
  const recent = samples
    .filter((sample) => {
      const atMs = Date.parse(sample.at);
      return Number.isFinite(atMs) && atMs >= windowStart;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  if (recent.length < 2) {
    return false;
  }

  const firstMs = Date.parse(recent[0].at);
  const lastMs = Date.parse(recent[recent.length - 1].at);
  if (lastMs - firstMs < stillMinutes * 60_000) {
    return false;
  }

  const isStill = recent.every((sample) => sample.speedKph <= 1.5);
  if (!isStill) {
    return false;
  }

  const anchor = recent[0];
  let maxDrift = 0;
  for (const sample of recent) {
    maxDrift = Math.max(maxDrift, distanceMeters(anchor, sample));
  }

  return maxDrift <= maxDriftM;
}
