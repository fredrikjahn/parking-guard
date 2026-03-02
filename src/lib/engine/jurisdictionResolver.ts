import { repo } from '@/lib/db/repo';

type Bbox = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

export type ResolvedRulesSource = {
  id: string;
  provider_key: string;
  config: Record<string, unknown>;
};

export type ResolvedJurisdiction = {
  id: string;
  country: string;
  name: string;
  bbox: Bbox | null;
} | null;

function parseBbox(raw: unknown): Bbox | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const value = raw as Partial<Bbox>;
  if (
    typeof value.minLat !== 'number' ||
    typeof value.maxLat !== 'number' ||
    typeof value.minLng !== 'number' ||
    typeof value.maxLng !== 'number'
  ) {
    return null;
  }

  return {
    minLat: value.minLat,
    maxLat: value.maxLat,
    minLng: value.minLng,
    maxLng: value.maxLng,
  };
}

function inBbox(lat: number, lng: number, bbox: Bbox): boolean {
  return lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
}

export async function resolveRulesSourcesForPosition(lat: number, lng: number): Promise<{
  jurisdiction: ResolvedJurisdiction;
  rulesSources: ResolvedRulesSource[];
}> {
  const rows = await repo.listEnabledRulesSourcesWithJurisdiction();

  const candidates = rows
    .map((row) => {
      const jurisdictionRaw = Array.isArray(row.jurisdiction) ? row.jurisdiction[0] : row.jurisdiction;
      const bbox = parseBbox(jurisdictionRaw?.bbox ?? null);
      return {
        id: row.id,
        provider_key: row.provider_key,
        config: (row.config ?? {}) as Record<string, unknown>,
        jurisdiction: jurisdictionRaw
          ? {
              id: jurisdictionRaw.id as string,
              country: (jurisdictionRaw.country as string) ?? 'SE',
              name: (jurisdictionRaw.name as string) ?? 'Unknown',
              bbox,
            }
          : null,
      };
    })
    .filter((entry) => {
      if (!entry.jurisdiction) {
        return false;
      }
      if (!entry.jurisdiction.bbox) {
        return true;
      }
      return inBbox(lat, lng, entry.jurisdiction.bbox);
    });

  if (candidates.length === 0) {
    return { jurisdiction: null, rulesSources: [] };
  }

  const jurisdiction = candidates[0].jurisdiction;
  const rulesSources = candidates
    .filter((candidate) => candidate.jurisdiction?.id === jurisdiction?.id)
    .map((candidate) => ({
      id: candidate.id,
      provider_key: candidate.provider_key,
      config: candidate.config,
    }));

  return { jurisdiction, rulesSources };
}
