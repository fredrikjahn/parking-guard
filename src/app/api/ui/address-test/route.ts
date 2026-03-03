import { z } from 'zod';
import { config } from '@/lib/config';
import { stockholmWithin } from '@/lib/providers/rules/stockholmLtf';
import { buildRulePresentation } from '@/lib/parking/parkingStatus';

const querySchema = z.object({
  address: z.string().trim().min(3),
});

type NominatimSearchResult = {
  lat: string;
  lon: string;
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    pedestrian?: string;
    footway?: string;
    street?: string;
    city_district?: string;
    suburb?: string;
    neighbourhood?: string;
  };
};

type NominatimReverseResult = {
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    pedestrian?: string;
    footway?: string;
    street?: string;
  };
};

type GenericFeature = {
  properties?: Record<string, unknown>;
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
  [key: string]: unknown;
};

type FeatureCollectionLike = {
  type?: string;
  features?: unknown;
  numberMatched?: number;
  numberReturned?: number;
  totalFeatures?: number;
  [key: string]: unknown;
};

type RuleHitRow = {
  severity: string;
  rule_type: 'servicedagar' | 'ptillaten';
  summary: string;
  raw_json: unknown;
};

type RuleFeatureSample = {
  ADDRESS: string | null;
  STREET_NAME: string | null;
  START_WEEKDAY: string | null;
  START_TIME: number | string | null;
  END_TIME: number | string | null;
  DAY_TYPE: string | null;
  PARKING_RATE: string | null;
  VF_PLATS_TYP: string | null;
  CITATION: string | null;
  RDT_URL: string | null;
};

type WeeklyScheduleRow = {
  from: string;
  to: string;
  label: string;
};

type WeeklyScheduleDay = {
  day: 'Mån' | 'Tis' | 'Ons' | 'Tor' | 'Fre' | 'Lör' | 'Sön';
  rows: WeeklyScheduleRow[];
};

type LastplatsEvidence = {
  address: string | null;
  placeType: string | null;
  vehicle: string | null;
  ruleType: 'servicedagar' | 'ptillaten';
};

type AnchorCandidate = {
  ruleType: 'servicedagar' | 'ptillaten';
  feature: GenericFeature;
  address: string | null;
  streetName: string | null;
  citation: string | null;
  placeType: string | null;
  vehicle: string | null;
  dayIndexes: number[];
  startMin: number | null;
  endMin: number | null;
  isLastplats: boolean;
  activeNow: boolean;
  blocksPassengerCarNow: boolean;
  score: number;
  sameStreet: boolean;
  distanceM: number | null;
};

type AnchorSelection = {
  ruleType: 'servicedagar' | 'ptillaten';
  address: string | null;
  streetName: string | null;
  citation: string | null;
  placeType: string | null;
  vehicle: string | null;
  dayIndexes: number[];
  startMin: number | null;
  endMin: number | null;
  activeNow: boolean;
  blocksPassengerCarNow: boolean;
  distanceM: number | null;
};

type AddressQueryHint = {
  street: string | null;
  houseNumber: string | null;
};

type ResolvedInput = {
  displayName: string;
  lat: number;
  lng: number;
  street: string | null;
  houseNumber: string | null;
  inputMode: 'address' | 'coords';
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeCompact(value: string): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function parseAddressQueryHint(address: string): AddressQueryHint {
  const firstPart = address.split(',')[0]?.trim() ?? address.trim();
  if (!firstPart) {
    return { street: null, houseNumber: null };
  }

  const match = firstPart.match(/^(.+?)\s+(\d+[a-zA-Z]?)$/);
  if (match) {
    const street = match[1]?.trim() ?? null;
    const houseNumber = match[2]?.trim() ?? null;
    return {
      street: street && street.length > 0 ? street : null,
      houseNumber: houseNumber && houseNumber.length > 0 ? houseNumber : null,
    };
  }

  return {
    street: firstPart,
    houseNumber: null,
  };
}

function parseCoordinateInput(input: string): { lat: number; lng: number } | null {
  const match = input.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number.parseFloat(match[1] ?? '');
  const lng = Number.parseFloat(match[2] ?? '');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function parseNumberToken(value: string): { number: number; suffix: string | null } | null {
  const match = value.match(/(\d+)\s*([a-zA-Z]?)$/);
  if (!match) return null;
  const numberValue = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(numberValue)) return null;
  const suffix = (match[2] ?? '').trim().toLowerCase();
  return { number: numberValue, suffix: suffix || null };
}

function addressMatchScore(address: string, streetName: string | null, houseNumber: string | null): number {
  if (!streetName) return 1;
  const normalizedStreet = normalizeText(streetName);
  const normalizedAddress = normalizeText(address);
  if (!normalizedAddress.includes(normalizedStreet)) return 0;
  if (!houseNumber) return 1;

  const targetCompact = normalizeCompact(houseNumber);
  const addressCompact = normalizeCompact(address);
  if (addressCompact.includes(targetCompact)) return 3;

  const targetToken = parseNumberToken(houseNumber);
  if (!targetToken) return 0;

  const rangeMatches = [...address.matchAll(/(\d+\s*[a-zA-Z]?)\s*-\s*(\d+\s*[a-zA-Z]?)/g)];
  for (const rangeMatch of rangeMatches) {
    const start = parseNumberToken((rangeMatch[1] ?? '').trim());
    const end = parseNumberToken((rangeMatch[2] ?? '').trim());
    if (!start || !end) continue;
    const min = Math.min(start.number, end.number);
    const max = Math.max(start.number, end.number);
    if (targetToken.number < min || targetToken.number > max) continue;
    if (targetToken.number === start.number && start.suffix && targetToken.suffix) {
      return start.suffix === targetToken.suffix ? 2 : 0;
    }
    if (targetToken.number === end.number && end.suffix && targetToken.suffix) {
      return end.suffix === targetToken.suffix ? 2 : 0;
    }
    return 1;
  }

  return 0;
}

function collectLngLatPairs(value: unknown, out: Array<[number, number]>): void {
  if (!Array.isArray(value)) return;
  if (
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  ) {
    out.push([value[0], value[1]]);
    return;
  }
  for (const nested of value) {
    collectLngLatPairs(nested, out);
  }
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthRadiusM = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(a));
}

function minDistanceToFeatureMeters(feature: GenericFeature, lat: number, lng: number): number | null {
  const coords = feature.geometry?.coordinates;
  const pairs: Array<[number, number]> = [];
  collectLngLatPairs(coords, pairs);
  if (pairs.length === 0) return null;

  let min = Number.POSITIVE_INFINITY;
  for (const [featureLng, featureLat] of pairs) {
    const distance = haversineMeters(lat, lng, featureLat, featureLng);
    if (distance < min) min = distance;
  }
  return Number.isFinite(min) ? min : null;
}

function isFeatureCollectionLike(value: unknown): value is FeatureCollectionLike {
  return Boolean(value) && typeof value === 'object';
}

function extractFeatureCollection(rawJson: unknown): { collection: FeatureCollectionLike | null; wrapperKey: string | null } {
  if (!isFeatureCollectionLike(rawJson)) return { collection: null, wrapperKey: null };
  const asRecord = rawJson as Record<string, unknown>;
  if (Array.isArray(asRecord.features)) {
    return { collection: asRecord as FeatureCollectionLike, wrapperKey: null };
  }
  for (const [key, value] of Object.entries(asRecord)) {
    if (!isFeatureCollectionLike(value)) continue;
    const nested = value as Record<string, unknown>;
    if (Array.isArray(nested.features)) {
      return { collection: nested as FeatureCollectionLike, wrapperKey: key };
    }
  }
  return { collection: null, wrapperKey: null };
}

function patchCollection(rawJson: unknown, wrapperKey: string | null, features: GenericFeature[]): unknown {
  if (!isFeatureCollectionLike(rawJson)) return rawJson;
  const base = rawJson as Record<string, unknown>;
  const patchCounts = (value: Record<string, unknown>) => ({
    ...value,
    features,
    numberMatched: features.length,
    numberReturned: features.length,
    totalFeatures: features.length,
  });
  if (!wrapperKey) return patchCounts(base);
  const nested = base[wrapperKey];
  if (!isFeatureCollectionLike(nested)) return rawJson;
  return {
    ...base,
    [wrapperKey]: patchCounts(nested as Record<string, unknown>),
  };
}

function compactOrEmpty(value: string | null): string {
  return value ? normalizeCompact(value) : '';
}

function extractCandidatesFromRaw(input: {
  rawJson: unknown;
  ruleType: 'servicedagar' | 'ptillaten';
  streetName: string | null;
  houseNumber: string | null;
  lat: number;
  lng: number;
  nowWeekday: number;
  nowMinute: number;
}): AnchorCandidate[] {
  const extracted = extractFeatureCollection(input.rawJson);
  const collection = extracted.collection;
  const features = Array.isArray(collection?.features) ? (collection.features as GenericFeature[]) : [];
  const wantedStreet = compactOrEmpty(input.streetName);

  return features.map((feature) => {
    const props = feature.properties ?? {};
    const address = typeof props.ADDRESS === 'string' ? props.ADDRESS : null;
    const streetName = typeof props.STREET_NAME === 'string' ? props.STREET_NAME : null;
    const citation = typeof props.CITATION === 'string' ? props.CITATION : null;
    const placeType = typeof props.VF_PLATS_TYP === 'string' ? props.VF_PLATS_TYP.trim() : null;
    const vehicle = typeof props.VEHICLE === 'string' ? props.VEHICLE.trim() : null;
    const score = address ? addressMatchScore(address, input.streetName, input.houseNumber) : 0;
    const candidateStreet = compactOrEmpty(streetName);
    const candidateAddress = compactOrEmpty(address);
    const sameStreet = wantedStreet
      ? candidateStreet === wantedStreet || candidateAddress.includes(wantedStreet)
      : true;
    const dayIndexes = extractActiveDays(props);
    const startMin = parseTimeTokenToMinutes(props.START_TIME);
    const endRaw = parseTimeTokenToMinutes(props.END_TIME);
    const endMin = endRaw === 0 ? 24 * 60 : endRaw;
    const activeNow = isNowInFeatureWindow({
      nowWeekday: input.nowWeekday,
      nowMinute: input.nowMinute,
      dayIndexes,
      startMin,
      endMin,
    });
    const isLastplats = isLastplatsFeature(placeType, vehicle);
    const blocksPassengerCarNow =
      activeNow &&
      (input.ruleType === 'servicedagar' || (isLastplats && !allowsPassengerCar(vehicle)));

    return {
      ruleType: input.ruleType,
      feature,
      address,
      streetName,
      citation,
      placeType,
      vehicle,
      dayIndexes,
      startMin,
      endMin,
      isLastplats,
      activeNow,
      blocksPassengerCarNow,
      score,
      sameStreet,
      distanceM: minDistanceToFeatureMeters(feature, input.lat, input.lng),
    };
  });
}

function chooseAnchorSelection(input: {
  servicedagarRaw: unknown;
  ptillatenRaw: unknown;
  streetName: string | null;
  houseNumber: string | null;
  lat: number;
  lng: number;
  inputMode: 'address' | 'coords';
  now: Date;
}): AnchorSelection | null {
  const nowParts = getStockholmNowParts(input.now);
  const candidates = [
    ...extractCandidatesFromRaw({
      rawJson: input.servicedagarRaw,
      ruleType: 'servicedagar',
      streetName: input.streetName,
      houseNumber: input.houseNumber,
      lat: input.lat,
      lng: input.lng,
      nowWeekday: nowParts.weekdayIndex,
      nowMinute: nowParts.minuteOfDay,
    }),
    ...extractCandidatesFromRaw({
      rawJson: input.ptillatenRaw,
      ruleType: 'ptillaten',
      streetName: input.streetName,
      houseNumber: input.houseNumber,
      lat: input.lat,
      lng: input.lng,
      nowWeekday: nowParts.weekdayIndex,
      nowMinute: nowParts.minuteOfDay,
    }),
  ];
  if (candidates.length === 0) return null;

  const sorted = candidates.sort((a, b) => {
    const priorityScore = (candidate: AnchorCandidate): number => {
      let total = 0;
      if (candidate.blocksPassengerCarNow) total += 500;
      if (candidate.activeNow) total += 250;
      if (candidate.isLastplats) total += 120;
      if (candidate.ruleType === 'servicedagar') total += 40;
      if (candidate.sameStreet) total += 35;
      total += Math.max(0, candidate.score) * 20;
      if (candidate.distanceM !== null) {
        total += Math.max(0, 100 - Math.min(candidate.distanceM, 100));
      }
      return total;
    };

    const scoreA = priorityScore(a);
    const scoreB = priorityScore(b);
    if (scoreB !== scoreA) return scoreB - scoreA;

    if (input.inputMode === 'coords') {
      if (Number(b.sameStreet) !== Number(a.sameStreet)) {
        return Number(b.sameStreet) - Number(a.sameStreet);
      }
      const aDist = a.distanceM ?? Number.POSITIVE_INFINITY;
      const bDist = b.distanceM ?? Number.POSITIVE_INFINITY;
      if (aDist !== bDist) return aDist - bDist;
      if (b.score !== a.score) return b.score - a.score;
    } else {
      if (b.score !== a.score) return b.score - a.score;
      if (Number(b.sameStreet) !== Number(a.sameStreet)) {
        return Number(b.sameStreet) - Number(a.sameStreet);
      }
      const aDist = a.distanceM ?? Number.POSITIVE_INFINITY;
      const bDist = b.distanceM ?? Number.POSITIVE_INFINITY;
      if (aDist !== bDist) return aDist - bDist;
    }
    if (a.citation && !b.citation) return -1;
    if (!a.citation && b.citation) return 1;
    return 0;
  });

  const best = sorted[0];
  if (!best) return null;
  return {
    ruleType: best.ruleType,
    address: best.address,
    streetName: best.streetName,
    citation: best.citation,
    placeType: best.placeType,
    vehicle: best.vehicle,
    dayIndexes: best.dayIndexes,
    startMin: best.startMin,
    endMin: best.endMin,
    activeNow: best.activeNow,
    blocksPassengerCarNow: best.blocksPassengerCarNow,
    distanceM: best.distanceM,
  };
}

function filterRawJsonByAnchor(input: {
  rawJson: unknown;
  anchor: AnchorSelection;
  lat: number;
  lng: number;
}): { filteredRawJson: unknown; selectedAddress: string | null; selectedCitation: string | null } {
  const extracted = extractFeatureCollection(input.rawJson);
  const collection = extracted.collection;
  if (!collection || !Array.isArray(collection.features)) {
    return { filteredRawJson: input.rawJson, selectedAddress: null, selectedCitation: null };
  }

  const features = collection.features.filter(
    (entry): entry is GenericFeature => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
  );
  if (features.length === 0) {
    return { filteredRawJson: input.rawJson, selectedAddress: null, selectedCitation: null };
  }

  const byCitation =
    input.anchor.citation && input.anchor.citation.length > 0
      ? features.filter((feature) => feature.properties?.CITATION === input.anchor.citation)
      : [];
  if (byCitation.length > 0) {
    const firstAddress = typeof byCitation[0]?.properties?.ADDRESS === 'string' ? byCitation[0].properties.ADDRESS : null;
    return {
      filteredRawJson: patchCollection(input.rawJson, extracted.wrapperKey, byCitation),
      selectedAddress: firstAddress,
      selectedCitation: input.anchor.citation,
    };
  }

  const anchorAddressCompact = compactOrEmpty(input.anchor.address);
  const byAddress = anchorAddressCompact
    ? features.filter((feature) => {
        const address = feature.properties?.ADDRESS;
        return typeof address === 'string' && compactOrEmpty(address) === anchorAddressCompact;
      })
    : [];
  if (byAddress.length > 0) {
    const firstCitation = typeof byAddress[0]?.properties?.CITATION === 'string' ? byAddress[0].properties.CITATION : null;
    return {
      filteredRawJson: patchCollection(input.rawJson, extracted.wrapperKey, byAddress),
      selectedAddress: input.anchor.address,
      selectedCitation: firstCitation,
    };
  }

  const anchorStreetCompact = compactOrEmpty(input.anchor.streetName);
  const byStreet = anchorStreetCompact
    ? features.filter((feature) => {
        const props = feature.properties ?? {};
        const street = typeof props.STREET_NAME === 'string' ? props.STREET_NAME : null;
        const address = typeof props.ADDRESS === 'string' ? props.ADDRESS : null;
        return compactOrEmpty(street) === anchorStreetCompact || compactOrEmpty(address).includes(anchorStreetCompact);
      })
    : [];
  if (byStreet.length > 0) {
    const nearestOnStreet = byStreet
      .map((feature) => ({ feature, dist: minDistanceToFeatureMeters(feature, input.lat, input.lng) }))
      .sort((a, b) => (a.dist ?? Number.POSITIVE_INFINITY) - (b.dist ?? Number.POSITIVE_INFINITY))[0]?.feature;
    const selectedFeatures = nearestOnStreet ? [nearestOnStreet] : [byStreet[0]];
    const first = selectedFeatures[0];
    return {
      filteredRawJson: patchCollection(input.rawJson, extracted.wrapperKey, selectedFeatures),
      selectedAddress: typeof first?.properties?.ADDRESS === 'string' ? first.properties.ADDRESS : null,
      selectedCitation: typeof first?.properties?.CITATION === 'string' ? first.properties.CITATION : null,
    };
  }

  const nearest = features
    .map((feature) => ({ feature, dist: minDistanceToFeatureMeters(feature, input.lat, input.lng) }))
    .sort((a, b) => (a.dist ?? Number.POSITIVE_INFINITY) - (b.dist ?? Number.POSITIVE_INFINITY))[0]?.feature;
  const fallback = nearest ?? features[0];
  return {
    filteredRawJson: patchCollection(input.rawJson, extracted.wrapperKey, [fallback]),
    selectedAddress: typeof fallback?.properties?.ADDRESS === 'string' ? fallback.properties.ADDRESS : null,
    selectedCitation: typeof fallback?.properties?.CITATION === 'string' ? fallback.properties.CITATION : null,
  };
}

function parseTimeTokenToMinutes(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.round(raw);
    if (n === 2400) return 24 * 60;
    if (n >= 100) {
      const hh = Math.floor(n / 100);
      const mm = n % 100;
      if (hh >= 0 && hh <= 24 && mm >= 0 && mm <= 59) return hh * 60 + mm;
    }
    if (n >= 0 && n <= 24 * 60) return n;
    return null;
  }
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (/^\d{1,4}$/.test(value)) return parseTimeTokenToMinutes(Number.parseInt(value, 10));
  return null;
}

function parseWeekdayToIndex(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const value = normalizeText(raw);
  const map: Record<string, number> = {
    mandag: 0,
    tisdag: 1,
    onsdag: 2,
    torsdag: 3,
    fredag: 4,
    lordag: 5,
    sondag: 6,
    monday: 0,
    tuesday: 1,
    wednesday: 2,
    thursday: 3,
    friday: 4,
    saturday: 5,
    sunday: 6,
  };
  return map[value] ?? null;
}

const stockholmWeekdayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  weekday: 'short',
});

const stockholmTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function getStockholmNowParts(now: Date): { weekdayIndex: number; minuteOfDay: number } {
  const weekdayStr = stockholmWeekdayFormatter.format(now);
  const timeStr = stockholmTimeFormatter.format(now);
  const [hhRaw, mmRaw] = timeStr.split(':');
  const hh = Number.parseInt(hhRaw ?? '0', 10);
  const mm = Number.parseInt(mmRaw ?? '0', 10);
  const minuteOfDay = (Number.isFinite(hh) ? hh : 0) * 60 + (Number.isFinite(mm) ? mm : 0);
  const weekdayMap: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  return {
    weekdayIndex: weekdayMap[weekdayStr] ?? 0,
    minuteOfDay,
  };
}

function parseDayTypeToIndexes(raw: unknown): number[] {
  if (typeof raw !== 'string') return [];
  const value = normalizeText(raw);
  if (!value) return [];
  if (value.includes('alla dagar')) return [0, 1, 2, 3, 4, 5, 6];
  if (value.includes('vardag')) return [0, 1, 2, 3, 4];
  if (value.includes('helgdag')) return [5, 6];
  const out = new Set<number>();
  const dayTokens = value.split(/\s+/);
  for (const token of dayTokens) {
    const idx = parseWeekdayToIndex(token);
    if (idx !== null) out.add(idx);
  }
  return Array.from(out);
}

function extractActiveDays(props: Record<string, unknown>): number[] {
  const weekday = parseWeekdayToIndex(props.START_WEEKDAY);
  if (weekday !== null) return [weekday];
  return parseDayTypeToIndexes(props.DAY_TYPE);
}

function isNowInFeatureWindow(input: {
  nowWeekday: number;
  nowMinute: number;
  dayIndexes: number[];
  startMin: number | null;
  endMin: number | null;
}): boolean {
  if (input.dayIndexes.length === 0) return false;
  if (input.startMin === null || input.endMin === null) return false;
  if (!input.dayIndexes.includes(input.nowWeekday)) return false;
  return input.nowMinute >= input.startMin && input.nowMinute < input.endMin;
}

function isLastplatsFeature(placeType: string | null, vehicle: string | null): boolean {
  const haystack = `${placeType ?? ''} ${vehicle ?? ''}`.toLowerCase();
  return (
    haystack.includes('lastplats') ||
    haystack.includes('lastzon') ||
    haystack.includes('loading') ||
    haystack.includes('lastning')
  );
}

function allowsPassengerCar(vehicle: string | null): boolean {
  if (!vehicle) return false;
  const v = normalizeText(vehicle);
  if (!v) return false;
  if (v.includes('fordon') || v.includes('personbil')) return true;
  return false;
}

function parseHourToMinutes(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n * 60 : 0;
}

function parseRateNumber(raw: string): number | null {
  const n = Number.parseFloat(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function addRateWindow(
  windows: Array<{ dayIndexes: number[]; startMin: number; endMin: number; pricePerHour: number }>,
  dayIndexes: number[],
  startHourRaw: string,
  endHourRaw: string,
  priceRaw: string,
): void {
  const pricePerHour = parseRateNumber(priceRaw);
  if (pricePerHour === null) return;
  const startMin = parseHourToMinutes(startHourRaw);
  const endCandidate = parseHourToMinutes(endHourRaw);
  const endMin = endCandidate === 0 ? 24 * 60 : endCandidate;
  if (endMin <= startMin) return;
  windows.push({
    dayIndexes,
    startMin,
    endMin,
    pricePerHour,
  });
}

function parseParkingRateText(rateText: string): Array<{ dayIndexes: number[]; startMin: number; endMin: number; pricePerHour: number }> {
  const normalized = rateText
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const windows: Array<{ dayIndexes: number[]; startMin: number; endMin: number; pricePerHour: number }> = [];

  const baselineMatch = normalized.match(/(\d+(?:[.,]\d+)?)\s*kr\s*\/?\s*tim\s*ovrig\s*tid/);
  if (baselineMatch) {
    addRateWindow(windows, [0, 1, 2, 3, 4, 5, 6], '0', '24', baselineMatch[1] ?? '0');
  }

  const allDaysMatch = normalized.match(
    /(\d+(?:[.,]\d+)?)\s*kr\s*\/?\s*tim\s*alla\s*dagar\s*(\d{1,2})\s*(?:-|–|—|till|to)?\s*(\d{1,2})/,
  );
  if (allDaysMatch) {
    addRateWindow(windows, [0, 1, 2, 3, 4, 5, 6], allDaysMatch[2] ?? '0', allDaysMatch[3] ?? '0', allDaysMatch[1] ?? '0');
  }

  const weekdayMatch = normalized.match(
    /(\d+(?:[.,]\d+)?)\s*kr\s*\/?\s*tim\s*vardagar\s*(\d{1,2})\s*(?:-|–|—|till|to)?\s*(\d{1,2})/,
  );
  if (weekdayMatch) {
    addRateWindow(windows, [0, 1, 2, 3, 4], weekdayMatch[2] ?? '0', weekdayMatch[3] ?? '0', weekdayMatch[1] ?? '0');
  }

  const beforeHolidayAndHolidaySamePrice = normalized.match(
    /(\d+(?:[.,]\d+)?)\s*kr\s*\/?\s*tim\s*vardagar\s*\d{1,2}\s*(?:-|–|—|till|to)?\s*\d{1,2}\s*och\s*dag\s*fore\s*helgdag\s*och\s*helgdag\s*(\d{1,2})\s*(?:-|–|—|till|to)?\s*(\d{1,2})/,
  );
  if (beforeHolidayAndHolidaySamePrice) {
    addRateWindow(
      windows,
      [5, 6],
      beforeHolidayAndHolidaySamePrice[2] ?? '0',
      beforeHolidayAndHolidaySamePrice[3] ?? '0',
      beforeHolidayAndHolidaySamePrice[1] ?? '0',
    );
  }

  const beforeHolidayMatch = normalized.match(
    /(\d+(?:[.,]\d+)?)\s*kr\s*\/?\s*tim\s*dag\s*fore\s*helgdag(?:\s*och\s*helgdag)?\s*(\d{1,2})\s*(?:-|–|—|till|to)?\s*(\d{1,2})/,
  );
  if (beforeHolidayMatch) {
    addRateWindow(
      windows,
      [5],
      beforeHolidayMatch[2] ?? '0',
      beforeHolidayMatch[3] ?? '0',
      beforeHolidayMatch[1] ?? '0',
    );
  }

  const holidayMatch = normalized.match(
    /(\d+(?:[.,]\d+)?)\s*kr\s*\/?\s*tim\s*helgdag\s*(\d{1,2})\s*(?:-|–|—|till|to)?\s*(\d{1,2})/,
  );
  if (holidayMatch) {
    addRateWindow(windows, [6], holidayMatch[2] ?? '0', holidayMatch[3] ?? '0', holidayMatch[1] ?? '0');
  }

  return windows;
}

function dayLabel(index: number): WeeklyScheduleDay['day'] {
  const map: WeeklyScheduleDay['day'][] = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];
  return map[index] ?? 'Mån';
}

function formatClock(minuteOfDay: number): string {
  const bounded = Math.max(0, Math.min(minuteOfDay, 24 * 60));
  const hh = Math.floor(bounded / 60)
    .toString()
    .padStart(2, '0');
  const mm = (bounded % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatDayIndexes(dayIndexes: number[]): string {
  const unique = Array.from(new Set(dayIndexes)).sort((a, b) => a - b);
  if (unique.length === 0) return 'okänd dag';
  return unique.map((idx) => dayLabel(idx).toLowerCase()).join(', ');
}

function formatWindowText(dayIndexes: number[], startMin: number | null, endMin: number | null): string | null {
  if (startMin === null || endMin === null) return null;
  if (dayIndexes.length === 0) return `${formatClock(startMin)}-${formatClock(endMin)}`;
  return `${formatDayIndexes(dayIndexes)} ${formatClock(startMin)}-${formatClock(endMin)}`;
}

function formatSlotMinute(min: number): string {
  const value = Math.max(0, Math.min(min, 24 * 60));
  if (value === 24 * 60) return '24';
  const hh = Math.floor(value / 60)
    .toString()
    .padStart(2, '0');
  const mm = (value % 60).toString().padStart(2, '0');
  return mm === '00' ? hh : `${hh}:${mm}`;
}

function formatPriceLabel(pricePerHour?: number): string {
  if (pricePerHour === undefined) return 'Betald';
  return Number.isInteger(pricePerHour) ? `${pricePerHour} kr` : `${pricePerHour.toFixed(2).replace('.', ',')} kr`;
}

function buildWeeklyScheduleFromRaw(ruleHits: RuleHitRow[]): WeeklyScheduleDay[] {
  const windows: Array<{ dayIndex: number; startMin: number; endMin: number; kind: 'FORBIDDEN' | 'PAID'; pricePerHour?: number }> = [];

  for (const hit of ruleHits) {
    const extracted = extractFeatureCollection(hit.raw_json);
    const collection = extracted.collection;
    const features = Array.isArray(collection?.features) ? (collection.features as GenericFeature[]) : [];
    for (const feature of features) {
      const props = feature.properties ?? {};
      if (hit.rule_type === 'servicedagar') {
        const dayIndex = parseWeekdayToIndex(props.START_WEEKDAY);
        const startMin = parseTimeTokenToMinutes(props.START_TIME);
        const endRaw = parseTimeTokenToMinutes(props.END_TIME);
        const endMin = endRaw === 0 ? 24 * 60 : endRaw;
        if (dayIndex !== null && startMin !== null && endMin !== null && endMin > startMin) {
          windows.push({ dayIndex, startMin, endMin, kind: 'FORBIDDEN' });
        }
      }
      if (hit.rule_type === 'ptillaten') {
        const rateText = typeof props.PARKING_RATE === 'string' ? props.PARKING_RATE : '';
        const parsedRates = parseParkingRateText(rateText);
        for (const rate of parsedRates) {
          for (const dayIndex of rate.dayIndexes) {
            windows.push({ dayIndex, startMin: rate.startMin, endMin: rate.endMin, kind: 'PAID', pricePerHour: rate.pricePerHour });
          }
        }
      }
    }
  }

  const result: WeeklyScheduleDay[] = [];
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dayWindows = windows.filter((w) => w.dayIndex === dayIndex);
    const breakpoints = new Set<number>([0, 24 * 60]);
    for (const window of dayWindows) {
      breakpoints.add(window.startMin);
      breakpoints.add(window.endMin);
    }
    const points = Array.from(breakpoints).sort((a, b) => a - b);
    const rows: WeeklyScheduleRow[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i] ?? 0;
      const to = points[i + 1] ?? 0;
      if (to <= from) continue;
      const mid = from + (to - from) / 2;
      const forbidden = dayWindows.find((w) => w.kind === 'FORBIDDEN' && mid >= w.startMin && mid < w.endMin);
      const paid = dayWindows
        .filter((w) => w.kind === 'PAID' && mid >= w.startMin && mid < w.endMin)
        .sort((a, b) => (b.pricePerHour ?? 0) - (a.pricePerHour ?? 0))[0];
      let label = 'Gratis';
      if (forbidden) label = '🚫 Förbud';
      else if (paid) label = `${formatPriceLabel(paid.pricePerHour)}/tim`;

      const prev = rows[rows.length - 1];
      if (prev && prev.label === label && prev.to === formatSlotMinute(from)) {
        prev.to = formatSlotMinute(to);
      } else {
        rows.push({ from: formatSlotMinute(from), to: formatSlotMinute(to), label });
      }
    }
    result.push({ day: dayLabel(dayIndex), rows: rows.length > 0 ? rows : [{ from: '00', to: '24', label: 'Gratis' }] });
  }

  return result;
}

async function reverseGeocodePoint(lat: number, lng: number): Promise<{
  displayName: string | null;
  street: string | null;
  houseNumber: string | null;
}> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));

  const response = await fetch(url.toString(), {
    cache: 'no-store',
    headers: {
      'user-agent': 'ParkSignal/0.1 (address-test)',
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    return {
      displayName: null,
      street: null,
      houseNumber: null,
    };
  }

  const json = (await response.json()) as NominatimReverseResult;
  const street =
    json.address?.road ??
    json.address?.pedestrian ??
    json.address?.footway ??
    json.address?.street ??
    null;

  return {
    displayName: json.display_name ?? null,
    street,
    houseNumber: json.address?.house_number ?? null,
  };
}

async function geocodeAddress(address: string): Promise<ResolvedInput> {
  const asCoords = parseCoordinateInput(address);
  if (asCoords) {
    const reversed = await reverseGeocodePoint(asCoords.lat, asCoords.lng);
    return {
      displayName: reversed.displayName ?? address.trim(),
      lat: asCoords.lat,
      lng: asCoords.lng,
      street: reversed.street,
      houseNumber: reversed.houseNumber,
      inputMode: 'coords',
    };
  }

  const queryHint = parseAddressQueryHint(address);

  const parseFirstNominatim = (first: NominatimSearchResult | undefined) => {
    if (!first) {
      return null;
    }
    const lat = Number.parseFloat(first.lat);
    const lng = Number.parseFloat(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    const street =
      first.address?.road ??
      first.address?.pedestrian ??
      first.address?.footway ??
      first.address?.street ??
      null;
    const houseNumber = first.address?.house_number ?? null;
    return {
      displayName: first.display_name ?? address,
      lat,
      lng,
      street,
      houseNumber,
      inputMode: 'address' as const,
    };
  };

  const fetchNominatim = async (url: URL): Promise<NominatimSearchResult[]> => {
    const response = await fetch(url.toString(), {
      cache: 'no-store',
      headers: {
        'user-agent': 'ParkSignal/0.1 (address-test)',
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Geocoding failed (${response.status})`);
    }
    return (await response.json()) as NominatimSearchResult[];
  };

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'se');
  url.searchParams.set('q', address);
  const json = await fetchNominatim(url);
  const initialParsed = parseFirstNominatim(json[0]);
  if (!initialParsed) {
    throw new Error('No address match found');
  }

  if (queryHint.street) {
    const wantedStreet = normalizeCompact(queryHint.street);
    const gotStreet = initialParsed.street ? normalizeCompact(initialParsed.street) : '';
    if (wantedStreet && gotStreet && wantedStreet !== gotStreet) {
      const structuredUrl = new URL('https://nominatim.openstreetmap.org/search');
      structuredUrl.searchParams.set('format', 'jsonv2');
      structuredUrl.searchParams.set('addressdetails', '1');
      structuredUrl.searchParams.set('limit', '1');
      structuredUrl.searchParams.set('countrycodes', 'se');
      structuredUrl.searchParams.set(
        'street',
        `${queryHint.street}${queryHint.houseNumber ? ` ${queryHint.houseNumber}` : ''}`.trim(),
      );
      structuredUrl.searchParams.set('city', 'Stockholm');

      const structuredJson = await fetchNominatim(structuredUrl);
      const structuredParsed = parseFirstNominatim(structuredJson[0]);
      if (structuredParsed) {
        return structuredParsed;
      }
    }
  }

  return initialParsed;
}

function filterRawJsonToAddressOrNearest(input: {
  rawJson: unknown;
  streetName: string | null;
  houseNumber: string | null;
  lat: number;
  lng: number;
  strictNearest?: boolean;
}): { filteredRawJson: unknown; selectedAddress: string | null } {
  const extracted = extractFeatureCollection(input.rawJson);
  const collection = extracted.collection;
  if (!collection || !Array.isArray(collection.features)) {
    return { filteredRawJson: input.rawJson, selectedAddress: null };
  }

  const features = collection.features.filter(
    (entry): entry is GenericFeature => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
  );
  if (features.length === 0) {
    return { filteredRawJson: input.rawJson, selectedAddress: null };
  }

  const targetStreetCompact = input.streetName ? normalizeCompact(input.streetName) : '';
  const sameStreetFeatures = targetStreetCompact
    ? features.filter((feature) => {
        const props = feature.properties ?? {};
        const streetName = typeof props.STREET_NAME === 'string' ? props.STREET_NAME : null;
        const address = typeof props.ADDRESS === 'string' ? props.ADDRESS : null;
        if (streetName && normalizeCompact(streetName) === targetStreetCompact) return true;
        if (address && normalizeCompact(address).includes(targetStreetCompact)) return true;
        return false;
      })
    : features;
  const featuresForMatching = sameStreetFeatures.length > 0 ? sameStreetFeatures : features;

  if (input.strictNearest) {
    const nearest = featuresForMatching
      .map((feature) => ({
        feature,
        distanceM: minDistanceToFeatureMeters(feature, input.lat, input.lng),
        address: typeof feature.properties?.ADDRESS === 'string' ? feature.properties.ADDRESS : null,
      }))
      .filter((row) => row.distanceM !== null)
      .sort((a, b) => (a.distanceM ?? Number.POSITIVE_INFINITY) - (b.distanceM ?? Number.POSITIVE_INFINITY))[0];

    if (nearest) {
      return {
        filteredRawJson: patchCollection(input.rawJson, extracted.wrapperKey, [nearest.feature]),
        selectedAddress: nearest.address,
      };
    }
  }

  const scored = featuresForMatching
    .map((feature) => {
      const props = feature.properties ?? {};
      const address = typeof props.ADDRESS === 'string' ? props.ADDRESS : null;
      const score = address ? addressMatchScore(address, input.streetName, input.houseNumber) : 0;
      return { feature, address, score };
    })
    .sort((a, b) => b.score - a.score);

  const bestScore = scored[0]?.score ?? 0;
  if (bestScore > 0) {
    const selected = scored.filter((row) => row.score === bestScore);
    const selectedAddress = selected[0]?.address ?? null;
    const selectedFeatures = selected.map((row) => row.feature);
    return {
      filteredRawJson: patchCollection(input.rawJson, extracted.wrapperKey, selectedFeatures),
      selectedAddress,
    };
  }

  const nearest = featuresForMatching
    .map((feature) => ({
      feature,
      distanceM: minDistanceToFeatureMeters(feature, input.lat, input.lng),
      address: typeof feature.properties?.ADDRESS === 'string' ? feature.properties.ADDRESS : null,
    }))
    .filter((row) => row.distanceM !== null)
    .sort((a, b) => (a.distanceM ?? Number.POSITIVE_INFINITY) - (b.distanceM ?? Number.POSITIVE_INFINITY))[0];

  if (!nearest) {
    return {
        filteredRawJson: patchCollection(input.rawJson, extracted.wrapperKey, [featuresForMatching[0]]),
        selectedAddress:
          typeof featuresForMatching[0]?.properties?.ADDRESS === 'string'
            ? featuresForMatching[0].properties.ADDRESS
            : null,
      };
  }

  const selectedAddress = nearest.address;
  const selectedFeatures = selectedAddress
    ? features.filter((feature) => {
        const address = feature.properties?.ADDRESS;
        return typeof address === 'string' && normalizeCompact(address) === normalizeCompact(selectedAddress);
      })
    : [nearest.feature];

  return {
    filteredRawJson: patchCollection(input.rawJson, extracted.wrapperKey, selectedFeatures.length > 0 ? selectedFeatures : [nearest.feature]),
    selectedAddress,
  };
}

function countFeatures(rawJson: unknown): number {
  const extracted = extractFeatureCollection(rawJson);
  const collection = extracted.collection;
  if (!collection || !Array.isArray(collection.features)) return 0;
  return collection.features.length;
}

function selectFeatureSamples(rawJson: unknown, limit = 5): RuleFeatureSample[] {
  const extracted = extractFeatureCollection(rawJson);
  const collection = extracted.collection;
  const features = Array.isArray(collection?.features) ? (collection.features as GenericFeature[]) : [];
  return features.slice(0, limit).map((feature) => {
    const props = feature.properties ?? {};
    return {
      ADDRESS: typeof props.ADDRESS === 'string' ? props.ADDRESS : null,
      STREET_NAME: typeof props.STREET_NAME === 'string' ? props.STREET_NAME : null,
      START_WEEKDAY: typeof props.START_WEEKDAY === 'string' ? props.START_WEEKDAY : null,
      START_TIME: (typeof props.START_TIME === 'number' || typeof props.START_TIME === 'string') ? props.START_TIME : null,
      END_TIME: (typeof props.END_TIME === 'number' || typeof props.END_TIME === 'string') ? props.END_TIME : null,
      DAY_TYPE: typeof props.DAY_TYPE === 'string' ? props.DAY_TYPE : null,
      PARKING_RATE: typeof props.PARKING_RATE === 'string' ? props.PARKING_RATE : null,
      VF_PLATS_TYP: typeof props.VF_PLATS_TYP === 'string' ? props.VF_PLATS_TYP : null,
      CITATION: typeof props.CITATION === 'string' ? props.CITATION : null,
      RDT_URL: typeof props.RDT_URL === 'string' ? props.RDT_URL : null,
    };
  });
}

function collectLastplatsEvidence(rawJson: unknown, ruleType: 'servicedagar' | 'ptillaten'): LastplatsEvidence[] {
  const extracted = extractFeatureCollection(rawJson);
  const collection = extracted.collection;
  const features = Array.isArray(collection?.features) ? (collection.features as GenericFeature[]) : [];

  const out: LastplatsEvidence[] = [];
  for (const feature of features) {
    const props = feature.properties ?? {};
    const placeType = typeof props.VF_PLATS_TYP === 'string' ? props.VF_PLATS_TYP.trim() : null;
    const vehicle = typeof props.VEHICLE === 'string' ? props.VEHICLE.trim() : null;
    const address = typeof props.ADDRESS === 'string' ? props.ADDRESS.trim() : null;
    const isLastplats = isLastplatsFeature(placeType, vehicle);

    if (!isLastplats) continue;
    out.push({
      address,
      placeType,
      vehicle,
      ruleType,
    });
  }
  return out;
}

function summarizeLastplats(ruleHits: RuleHitRow[]) {
  const evidences: LastplatsEvidence[] = [];
  for (const hit of ruleHits) {
    if (hit.rule_type !== 'servicedagar' && hit.rule_type !== 'ptillaten') continue;
    evidences.push(...collectLastplatsEvidence(hit.raw_json, hit.rule_type));
  }

  const uniq = new Map<string, LastplatsEvidence>();
  for (const evidence of evidences) {
    const key = `${evidence.address ?? ''}|${evidence.placeType ?? ''}|${evidence.vehicle ?? ''}|${evidence.ruleType}`;
    if (!uniq.has(key)) {
      uniq.set(key, evidence);
    }
  }
  const items = Array.from(uniq.values());

  const addresses = Array.from(new Set(items.map((item) => item.address).filter((v): v is string => Boolean(v))));
  const placeTypes = Array.from(new Set(items.map((item) => item.placeType).filter((v): v is string => Boolean(v))));
  const vehicles = Array.from(new Set(items.map((item) => item.vehicle).filter((v): v is string => Boolean(v))));

  return {
    isLastplats: items.length > 0,
    evidenceCount: items.length,
    addresses,
    placeTypes,
    vehicles,
    items,
  };
}

function buildRadiusCandidates(defaultRadius: number): number[] {
  const base = Number.isFinite(defaultRadius) && defaultRadius > 0 ? Math.round(defaultRadius) : 50;
  const candidates = [base, Math.max(base, 150), Math.max(base, 300), Math.max(base, 500)];
  return Array.from(new Set(candidates));
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({
    address: searchParams.get('address'),
  });

  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const geocoded = await geocodeAddress(parsed.data.address);
    const radiusCandidates = buildRadiusCandidates(config.DEFAULT_RADIUS_M);
    const radiusAttempts: Array<{ radiusM: number; servicedagarFeatures: number; ptillatenFeatures: number }> = [];

    let filteredServicedagar:
      | {
          filteredRawJson: unknown;
          selectedAddress: string | null;
          selectedCitation?: string | null;
        }
      | null = null;
    let filteredPtillaten:
      | {
          filteredRawJson: unknown;
          selectedAddress: string | null;
          selectedCitation?: string | null;
        }
      | null = null;
    let usedRadiusM: number = radiusCandidates[0] ?? 50;
    let selectedAnchor: AnchorSelection | null = null;

    for (const radiusM of radiusCandidates) {
      const [servicedagarRaw, ptillatenRaw] = await Promise.all([
        stockholmWithin({
          foreskrift: 'servicedagar',
          lat: geocoded.lat,
          lng: geocoded.lng,
          radiusM,
        }),
        stockholmWithin({
          foreskrift: 'ptillaten',
          lat: geocoded.lat,
          lng: geocoded.lng,
          radiusM,
        }),
      ]);

      const anchor = chooseAnchorSelection({
        servicedagarRaw,
        ptillatenRaw,
        streetName: geocoded.street,
        houseNumber: geocoded.houseNumber,
        lat: geocoded.lat,
        lng: geocoded.lng,
        inputMode: geocoded.inputMode,
        now: new Date(),
      });
      selectedAnchor = anchor;

      const svcFiltered = anchor
        ? filterRawJsonByAnchor({
            rawJson: servicedagarRaw,
            anchor,
            lat: geocoded.lat,
            lng: geocoded.lng,
          })
        : filterRawJsonToAddressOrNearest({
            rawJson: servicedagarRaw,
            streetName: geocoded.street,
            houseNumber: geocoded.houseNumber,
            lat: geocoded.lat,
            lng: geocoded.lng,
            strictNearest: geocoded.inputMode === 'coords',
          });
      const ptiFiltered = anchor
        ? filterRawJsonByAnchor({
            rawJson: ptillatenRaw,
            anchor,
            lat: geocoded.lat,
            lng: geocoded.lng,
          })
        : filterRawJsonToAddressOrNearest({
            rawJson: ptillatenRaw,
            streetName: geocoded.street,
            houseNumber: geocoded.houseNumber,
            lat: geocoded.lat,
            lng: geocoded.lng,
            strictNearest: geocoded.inputMode === 'coords',
          });

      const servicedagarFeatures = countFeatures(svcFiltered.filteredRawJson);
      const ptillatenFeatures = countFeatures(ptiFiltered.filteredRawJson);
      radiusAttempts.push({ radiusM, servicedagarFeatures, ptillatenFeatures });

      filteredServicedagar = svcFiltered;
      filteredPtillaten = ptiFiltered;
      usedRadiusM = radiusM;

      if (servicedagarFeatures > 0 || ptillatenFeatures > 0) {
        break;
      }
    }

    const finalServicedagar = filteredServicedagar ?? {
      filteredRawJson: null,
      selectedAddress: null,
    };
    const finalPtillaten = filteredPtillaten ?? {
      filteredRawJson: null,
      selectedAddress: null,
    };

    const ruleHits: RuleHitRow[] = [
      {
        severity: countFeatures(finalServicedagar.filteredRawJson) > 0 ? 'WARN' : 'INFO',
        rule_type: 'servicedagar',
        summary: '',
        raw_json: finalServicedagar.filteredRawJson,
      },
      {
        severity: 'INFO',
        rule_type: 'ptillaten',
        summary: '',
        raw_json: finalPtillaten.filteredRawJson,
      },
    ];

    const presentedRuleHits = ruleHits.map((hit) => {
      const presentation = buildRulePresentation({
        rule_type: hit.rule_type,
        severity: hit.severity,
        summary: hit.summary,
        raw_json: hit.raw_json,
      });
      return {
        type: hit.rule_type,
        severity: hit.severity,
        count: countFeatures(hit.raw_json),
        short: presentation.shortText,
        lines: presentation.allRules,
      };
    });

    const lastplats = summarizeLastplats(ruleHits);
    const activeSegment = selectedAnchor
      ? {
          ruleType: selectedAnchor.ruleType,
          address: selectedAnchor.address,
          citation: selectedAnchor.citation,
          placeType: selectedAnchor.placeType,
          vehicle: selectedAnchor.vehicle,
          dayIndexes: selectedAnchor.dayIndexes,
          startMin: selectedAnchor.startMin,
          endMin: selectedAnchor.endMin,
          windowText: formatWindowText(selectedAnchor.dayIndexes, selectedAnchor.startMin, selectedAnchor.endMin),
          activeNow: selectedAnchor.activeNow,
          blocksPassengerCarNow: selectedAnchor.blocksPassengerCarNow,
          distanceM: selectedAnchor.distanceM,
        }
      : null;

    return Response.json({
      ok: true,
      queryAddress: parsed.data.address,
      resolvedAddress: geocoded.displayName,
      selectedRuleAddress: finalServicedagar.selectedAddress ?? finalPtillaten.selectedAddress ?? null,
      usedRadiusM,
      location: {
        lat: geocoded.lat,
        lng: geocoded.lng,
      },
      activeSegment,
      lastplats,
      ruleHits: presentedRuleHits,
      weeklySchedule: buildWeeklyScheduleFromRaw(ruleHits),
      debug: {
        servicedagarFeatures: countFeatures(finalServicedagar.filteredRawJson),
        ptillatenFeatures: countFeatures(finalPtillaten.filteredRawJson),
        servicedagarSamples: selectFeatureSamples(finalServicedagar.filteredRawJson),
        ptillatenSamples: selectFeatureSamples(finalPtillaten.filteredRawJson),
        radiusAttempts,
        inputMode: geocoded.inputMode,
        selectedAnchor,
        selectedCitations: {
          servicedagar: finalServicedagar.selectedCitation ?? null,
          ptillaten: finalPtillaten.selectedCitation ?? null,
        },
      },
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Address test failed',
      },
      { status: 502 },
    );
  }
}
