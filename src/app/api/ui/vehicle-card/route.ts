import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db/client';
import {
  buildRulePresentation,
} from '@/lib/parking/parkingStatus';

const DEV_USER_ID = process.env.DEV_USER_ID;

const querySchema = z.object({
  vehicleId: z.string().uuid(),
  now: z.string().optional(),
});

type VehicleRow = {
  id: string;
  nickname: string | null;
  vin: string | null;
  user_id: string;
  external_vehicle_id: string;
};

type LatestTelemetryRow = {
  ts: string;
  lat: number | string | null;
  lng: number | string | null;
  speed_kph: number | string | null;
  shift_state: string | null;
};

type VehicleEventRow = {
  id: string;
  type: string;
  ts: string;
  lat: number | string | null;
  lng: number | string | null;
  speed_kph: number | string | null;
  shift_state: string | null;
  meta: Record<string, unknown>;
};

type RuleHitRow = {
  severity: string;
  rule_type: string;
  summary: string;
  raw_json: unknown;
};

type ReverseGeocodeResponse = {
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
    city?: string;
    town?: string;
  };
};

type GeocodedAddress = {
  displayName: string | null;
  street: string | null;
  houseNumber: string | null;
  district: string | null;
};

type RuleOverview = {
  forbidden: string[];
  paid: string[];
  free: string[];
};

type StatusNow = 'OK' | 'FORBIDDEN' | 'UNKNOWN';

type NextRisk = {
  type: 'SERVICEDAY' | 'TIME_LIMIT' | 'FEE';
  startsAt: string;
  endsAt: string;
  message: string;
} | null;

type StatusSummary = {
  statusNow: StatusNow;
  headline: string;
  recommendation: string;
  nextRisk: NextRisk;
  nextRiskText: string | null;
  nextActionAt: string | null;
  servicedayText: string | null;
  allowedText: string | null;
  feeText: string | null;
  boendeText: string | null;
};

type ServicedayWindow = {
  weekdayIndex: number;
  startMin: number;
  endMin: number;
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

type TimeWindowKind = 'FORBIDDEN' | 'PAID';

type TimeWindow = {
  dayIndex: number;
  startMin: number;
  endMin: number;
  kind: TimeWindowKind;
  pricePerHour?: number;
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

function vinSuffix(vin: string | null): string {
  if (!vin) return 'okand';
  const trimmed = vin.trim();
  return trimmed ? trimmed.slice(-4) : 'okand';
}

function toNumber(value: number | string | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

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

function parseNumberToken(value: string): { number: number; suffix: string | null } | null {
  const match = value.match(/(\d+)\s*([a-zA-Z]?)$/);
  if (!match) return null;
  const numberValue = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(numberValue)) return null;
  const suffix = (match[2] ?? '').trim().toLowerCase();
  return { number: numberValue, suffix: suffix || null };
}

function extractPlacePart(line: string): string {
  const match = line.match(/plats:\s*([^|]+)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return line;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineMatchesAddress(
  line: string,
  streetName: string | null,
  houseNumber: string | null,
): boolean {
  return addressMatchScore(line, streetName, houseNumber) > 0;
}

function addressMatchScore(
  line: string,
  streetName: string | null,
  houseNumber: string | null,
): number {
  if (!streetName) {
    return 1;
  }

  const placePart = extractPlacePart(line);
  const normalizedStreet = normalizeText(streetName);
  const normalizedPlace = normalizeText(placePart);
  if (!normalizedPlace.includes(normalizedStreet)) {
    return 0;
  }

  if (!houseNumber) {
    return 1;
  }

  const targetCompact = normalizeCompact(houseNumber);
  const placeCompact = normalizeCompact(placePart);
  const targetToken = parseNumberToken(houseNumber);
  const rangeMatches = [...placePart.matchAll(/(\d+\s*[a-zA-Z]?)\s*-\s*(\d+\s*[a-zA-Z]?)/g)];
  const inRange = targetToken
    ? rangeMatches.some((rangeMatch) => {
        const start = parseNumberToken((rangeMatch[1] ?? '').trim());
        const end = parseNumberToken((rangeMatch[2] ?? '').trim());
        if (!start || !end) return false;
        const min = Math.min(start.number, end.number);
        const max = Math.max(start.number, end.number);
        if (targetToken.number < min || targetToken.number > max) return false;
        if (targetToken.number === start.number && start.suffix && targetToken.suffix) {
          return start.suffix === targetToken.suffix;
        }
        if (targetToken.number === end.number && end.suffix && targetToken.suffix) {
          return end.suffix === targetToken.suffix;
        }
        return true;
      })
    : false;

  const normalizedHouse = normalizeText(houseNumber);
  const exactHouseRegex = new RegExp(`(?:^|\\s)${escapeRegex(normalizedHouse)}(?:\\s|$)`, 'i');
  const hasExactHouse = exactHouseRegex.test(normalizedPlace);

  if (hasExactHouse) {
    return 3;
  }
  if (inRange) {
    return 1;
  }
  if (placeCompact.includes(targetCompact)) {
    return 2;
  }

  if (!targetToken) {
    return 0;
  }

  for (const rangeMatch of rangeMatches) {
    const start = parseNumberToken((rangeMatch[1] ?? '').trim());
    const end = parseNumberToken((rangeMatch[2] ?? '').trim());
    if (!start || !end) continue;

    const min = Math.min(start.number, end.number);
    const max = Math.max(start.number, end.number);
    if (targetToken.number < min || targetToken.number > max) {
      continue;
    }

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

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function classifyRuleLine(text: string, title: string): keyof RuleOverview {
  const normalized = `${title} ${text}`.toLowerCase();
  if (normalized.includes('parkeringsförbud') || normalized.includes('gatusopning')) {
    return 'forbidden';
  }
  if (normalized.includes('gratis parkering') || normalized.includes('taxa 0')) {
    return 'free';
  }
  if (normalized.includes('taxa') || normalized.includes('avgift')) {
    return 'paid';
  }
  return 'paid';
}

function formatShortAddress(input: GeocodedAddress): string | null {
  const street = input.street?.trim() ?? '';
  const houseNumber = input.houseNumber?.trim() ?? '';
  const district = input.district?.trim() ?? '';

  if (!street && !input.displayName) {
    return null;
  }

  if (street) {
    const left = houseNumber ? `${street} ${houseNumber}` : street;
    if (district) {
      return `${left}, ${district}`;
    }
    return left;
  }

  return input.displayName;
}

function normalizeDistrictValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function districtPriority(value: string): number {
  const normalized = normalizeText(value);
  if (!normalized) return -1;
  if (normalized.includes('stadsdelsomrade')) return 0;
  if (normalized.includes('innerstaden')) return 0;
  return 1;
}

function pickBestDistrict(candidates: string[]): string | null {
  const cleaned = candidates
    .map(normalizeDistrictValue)
    .filter((value) => value.length > 0);
  if (cleaned.length === 0) return null;

  const deduped = Array.from(new Set(cleaned));
  deduped.sort((a, b) => districtPriority(b) - districtPriority(a));
  return deduped[0] ?? null;
}

function isFeatureCollectionLike(value: unknown): value is FeatureCollectionLike {
  return Boolean(value) && typeof value === 'object';
}

function getFeatureAddress(feature: GenericFeature): string | null {
  const props = feature.properties ?? {};
  const address = props.ADDRESS;
  if (typeof address === 'string' && address.trim().length > 0) {
    return address.trim();
  }
  const street = props.STREET_NAME;
  if (typeof street === 'string' && street.trim().length > 0) {
    return street.trim();
  }
  return null;
}

function parseTimeTokenToMinutes(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.round(raw);
    if (n === 2400) return 24 * 60;
    if (n >= 100) {
      const hh = Math.floor(n / 100);
      const mm = n % 100;
      if (hh >= 0 && hh <= 24 && mm >= 0 && mm <= 59) {
        return hh * 60 + mm;
      }
    }
    if (n >= 0 && n <= 24 * 60) return n;
    return null;
  }

  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (/^\d{1,4}$/.test(value)) {
    return parseTimeTokenToMinutes(Number.parseInt(value, 10));
  }
  const hhmm = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!hhmm) return null;
  const hh = Number.parseInt(hhmm[1] ?? '0', 10);
  const mm = Number.parseInt(hhmm[2] ?? '0', 10);
  if (hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
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

const stockholmPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function getStockholmDateParts(date: Date): {
  weekdayIndex: number;
  year: number;
  month: number;
  day: number;
  minuteOfDay: number;
} {
  const parts = stockholmPartsFormatter.formatToParts(date);
  let weekday = 'Mon';
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;

  for (const part of parts) {
    if (part.type === 'weekday') weekday = part.value;
    if (part.type === 'year') year = Number.parseInt(part.value, 10);
    if (part.type === 'month') month = Number.parseInt(part.value, 10);
    if (part.type === 'day') day = Number.parseInt(part.value, 10);
    if (part.type === 'hour') hour = Number.parseInt(part.value, 10);
    if (part.type === 'minute') minute = Number.parseInt(part.value, 10);
  }

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
    weekdayIndex: weekdayMap[weekday] ?? 0,
    year,
    month,
    day,
    minuteOfDay: hour * 60 + minute,
  };
}

function findNextOccurrenceInStockholm(now: Date, weekdayIndex: number, minuteOfDay: number): Date | null {
  const startMs = now.getTime() - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds();
  const horizonMinutes = 14 * 24 * 60;

  for (let i = 0; i <= horizonMinutes; i += 1) {
    const candidate = new Date(startMs + i * 60 * 1000);
    const parts = getStockholmDateParts(candidate);
    if (parts.weekdayIndex === weekdayIndex && parts.minuteOfDay === minuteOfDay) {
      if (candidate.getTime() >= now.getTime()) {
        return candidate;
      }
    }
  }

  return null;
}

function diffCalendarDaysStockholm(from: Date, to: Date): number {
  const a = getStockholmDateParts(from);
  const b = getStockholmDateParts(to);
  const aUtc = Date.UTC(a.year, a.month - 1, a.day);
  const bUtc = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((bUtc - aUtc) / (24 * 60 * 60 * 1000));
}

function formatClock(minuteOfDay: number): string {
  const normalized = Math.max(0, Math.min(minuteOfDay, 24 * 60));
  const hh = Math.floor(normalized / 60)
    .toString()
    .padStart(2, '0');
  const mm = (normalized % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function describeDaysAway(days: number): string {
  if (days <= 0) return 'idag';
  if (days === 1) return 'om 1 dag';
  return `om ${days} dagar`;
}

function dayLabel(index: number): WeeklyScheduleDay['day'] {
  const map: WeeklyScheduleDay['day'][] = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];
  return map[index] ?? 'Mån';
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

function pickStateForRange(dayWindows: TimeWindow[], midMin: number): { kind: 'FORBIDDEN' | 'PAID' | 'FREE'; pricePerHour?: number } {
  const forbidden = dayWindows.find((window) => window.kind === 'FORBIDDEN' && midMin >= window.startMin && midMin < window.endMin);
  if (forbidden) {
    return { kind: 'FORBIDDEN' };
  }
  const paid = dayWindows
    .filter((window) => window.kind === 'PAID' && midMin >= window.startMin && midMin < window.endMin)
    .sort((a, b) => (b.pricePerHour ?? 0) - (a.pricePerHour ?? 0))[0];
  if (paid) {
    return { kind: 'PAID', pricePerHour: paid.pricePerHour };
  }
  return { kind: 'FREE' };
}

function buildWeeklyScheduleFromRaw(ruleHits: RuleHitRow[]): WeeklyScheduleDay[] {
  const windows: TimeWindow[] = [];

  for (const hit of ruleHits) {
    const extracted = extractCollectionFromRaw(hit.raw_json);
    const collection = extracted.collection;
    const features = Array.isArray(collection?.features) ? (collection?.features as GenericFeature[]) : [];
    for (const feature of features) {
      const props = feature.properties ?? {};

      if (hit.rule_type === 'servicedagar') {
        const dayIndex = parseWeekdayToIndex(props.START_WEEKDAY);
        const startMin = parseTimeTokenToMinutes(props.START_TIME);
        const endMinRaw = parseTimeTokenToMinutes(props.END_TIME);
        const endMin = endMinRaw === 0 ? 24 * 60 : endMinRaw;
        if (dayIndex !== null && startMin !== null && endMin !== null && endMin > startMin) {
          windows.push({
            dayIndex,
            startMin,
            endMin,
            kind: 'FORBIDDEN',
          });
        }
      }

      if (hit.rule_type === 'ptillaten') {
        const rateText = typeof props.PARKING_RATE === 'string' ? props.PARKING_RATE : '';
        const parsedRates = parseParkingRateText(rateText);
        for (const rate of parsedRates) {
          for (const dayIndex of rate.dayIndexes) {
            windows.push({
              dayIndex,
              startMin: rate.startMin,
              endMin: rate.endMin,
              kind: 'PAID',
              pricePerHour: rate.pricePerHour,
            });
          }
        }
      }
    }
  }

  const result: WeeklyScheduleDay[] = [];

  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dayWindows = windows.filter((window) => window.dayIndex === dayIndex);
    const breakpoints = new Set<number>([0, 24 * 60]);
    for (const window of dayWindows) {
      breakpoints.add(Math.max(0, Math.min(window.startMin, 24 * 60)));
      breakpoints.add(Math.max(0, Math.min(window.endMin, 24 * 60)));
    }

    const points = Array.from(breakpoints).sort((a, b) => a - b);
    const rows: WeeklyScheduleRow[] = [];

    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i] ?? 0;
      const to = points[i + 1] ?? 0;
      if (to <= from) continue;

      const mid = from + (to - from) / 2;
      const state = pickStateForRange(dayWindows, mid);
      const label =
        state.kind === 'FORBIDDEN'
          ? '🚫 Förbud'
          : state.kind === 'PAID'
            ? `${formatPriceLabel(state.pricePerHour)}/tim`
            : 'Gratis';

      const prev = rows[rows.length - 1];
      if (prev && prev.label === label && prev.to === formatSlotMinute(from)) {
        prev.to = formatSlotMinute(to);
      } else {
        rows.push({
          from: formatSlotMinute(from),
          to: formatSlotMinute(to),
          label,
        });
      }
    }

    result.push({
      day: dayLabel(dayIndex),
      rows: rows.length > 0 ? rows : [{ from: '00', to: '24', label: 'Gratis' }],
    });
  }

  return result;
}

function dedupeServicedayWindows(windows: ServicedayWindow[]): ServicedayWindow[] {
  const seen = new Set<string>();
  const out: ServicedayWindow[] = [];
  for (const window of windows) {
    const key = `${window.weekdayIndex}:${window.startMin}:${window.endMin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(window);
  }
  return out;
}

function extractServicedayWindows(ruleHits: RuleHitRow[]): ServicedayWindow[] {
  const windows: ServicedayWindow[] = [];
  for (const hit of ruleHits) {
    if (hit.rule_type !== 'servicedagar') continue;
    const extracted = extractCollectionFromRaw(hit.raw_json);
    const collection = extracted.collection;
    const features = Array.isArray(collection?.features) ? (collection.features as GenericFeature[]) : [];
    for (const feature of features) {
      const props = feature.properties ?? {};
      const weekdayIndex = parseWeekdayToIndex(props.START_WEEKDAY);
      const startMin = parseTimeTokenToMinutes(props.START_TIME);
      const endRaw = parseTimeTokenToMinutes(props.END_TIME);
      const endMin = endRaw === 0 ? 24 * 60 : endRaw;
      if (weekdayIndex === null || startMin === null || endMin === null) continue;
      if (endMin <= startMin) continue;
      windows.push({ weekdayIndex, startMin, endMin });
    }
  }
  return dedupeServicedayWindows(windows);
}

function parseParkingRateDetails(ruleHits: RuleHitRow[]): {
  feeText: string | null;
  boendeText: string | null;
} {
  const rateStrings = new Set<string>();
  for (const hit of ruleHits) {
    const extracted = extractCollectionFromRaw(hit.raw_json);
    const collection = extracted.collection;
    const features = Array.isArray(collection?.features) ? (collection.features as GenericFeature[]) : [];
    for (const feature of features) {
      const props = feature.properties ?? {};
      const rate = props.PARKING_RATE;
      if (typeof rate === 'string' && rate.trim().length > 0) {
        rateStrings.add(rate.trim());
      }
    }
  }

  if (rateStrings.size === 0) {
    return {
      feeText: null,
      boendeText: null,
    };
  }

  const merged = Array.from(rateStrings).join(' | ');
  const parsedWindows = parseParkingRateText(merged);
  const taxaMatch = merged.match(/taxa\s*(\d+)/i);
  const taxaLabel = taxaMatch?.[1] ? `Taxa ${taxaMatch[1]}` : 'Taxa';

  const weekdayWindows = parsedWindows
    .filter((window) => window.dayIndexes.length === 5 && window.dayIndexes.includes(0) && window.dayIndexes.includes(4))
    .sort((a, b) => (b.pricePerHour ?? 0) - (a.pricePerHour ?? 0));
  const weekendWindows = parsedWindows
    .filter((window) => window.dayIndexes.includes(5) || window.dayIndexes.includes(6))
    .sort((a, b) => (b.pricePerHour ?? 0) - (a.pricePerHour ?? 0));
  const fallbackWindow = parsedWindows.sort((a, b) => (b.pricePerHour ?? 0) - (a.pricePerHour ?? 0))[0];

  let feeText: string | null = null;
  if (weekdayWindows[0] && weekendWindows[0]) {
    const weekdayWindow = weekdayWindows[0];
    const weekendWindow = weekendWindows[0];
    feeText =
      `${taxaLabel}: vardag ${formatClock(weekdayWindow.startMin)}-${formatClock(weekdayWindow.endMin)} ` +
      `${formatPriceLabel(weekdayWindow.pricePerHour)}/tim, helg ${formatClock(weekendWindow.startMin)}-${formatClock(weekendWindow.endMin)} ` +
      `${formatPriceLabel(weekendWindow.pricePerHour)}/tim`;
  } else if (weekdayWindows[0]) {
    const weekdayWindow = weekdayWindows[0];
    feeText =
      `${taxaLabel}: vardag ${formatClock(weekdayWindow.startMin)}-${formatClock(weekdayWindow.endMin)} ` +
      `${formatPriceLabel(weekdayWindow.pricePerHour)}/tim`;
  } else if (fallbackWindow) {
    feeText =
      `${taxaLabel}: ${formatClock(fallbackWindow.startMin)}-${formatClock(fallbackWindow.endMin)} ` +
      `${formatPriceLabel(fallbackWindow.pricePerHour)}/tim`;
  } else if (/avgiftsfri/i.test(merged)) {
    feeText = 'Avgiftsfri';
  }

  const boendeMatch = merged.match(/boende:\s*([^|]+)/i);
  const boendeText = boendeMatch?.[1]?.trim() ?? null;

  return {
    feeText,
    boendeText,
  };
}

function formatServicedayWindow(window: ServicedayWindow): string {
  return `${dayLabel(window.weekdayIndex).toLowerCase()} ${formatClock(window.startMin)}-${formatClock(window.endMin)}`;
}

function formatAllowedWindow(ruleHits: RuleHitRow[]): string | null {
  for (const hit of ruleHits) {
    if (hit.rule_type !== 'ptillaten') continue;
    const extracted = extractCollectionFromRaw(hit.raw_json);
    const collection = extracted.collection;
    const features = Array.isArray(collection?.features) ? (collection.features as GenericFeature[]) : [];
    for (const feature of features) {
      const props = feature.properties ?? {};
      const weekdayIndex = parseWeekdayToIndex(props.START_WEEKDAY);
      const startMin = parseTimeTokenToMinutes(props.START_TIME);
      const endRaw = parseTimeTokenToMinutes(props.END_TIME);
      const endMin = endRaw === 0 ? 24 * 60 : endRaw;
      if (weekdayIndex === null || startMin === null || endMin === null) continue;
      if (endMin <= startMin) continue;
      return `${dayLabel(weekdayIndex).toLowerCase()} ${formatClock(startMin)}-${formatClock(endMin)}`;
    }
  }
  return null;
}

function buildStatusSummary(input: {
  now: Date;
  servicedayWindows: ServicedayWindow[];
  allowedText: string | null;
  feeText: string | null;
  boendeText: string | null;
}): StatusSummary {
  const nowParts = getStockholmDateParts(input.now);
  const active = input.servicedayWindows.find(
    (window) =>
      window.weekdayIndex === nowParts.weekdayIndex &&
      nowParts.minuteOfDay >= window.startMin &&
      nowParts.minuteOfDay < window.endMin,
  );

  if (active) {
    const activeStart = findNextOccurrenceInStockholm(
      new Date(input.now.getTime() - 6 * 24 * 60 * 60 * 1000),
      active.weekdayIndex,
      active.startMin,
    );
    const activeEnd = activeStart
      ? new Date(activeStart.getTime() + (active.endMin - active.startMin) * 60 * 1000)
      : null;
    const nextRisk: NextRisk =
      activeStart && activeEnd
        ? {
            type: 'SERVICEDAY',
            startsAt: activeStart.toISOString(),
            endsAt: activeEnd.toISOString(),
            message: `Gatusopning pågår nu (${formatServicedayWindow(active)})`,
          }
        : null;

    return {
      statusNow: 'FORBIDDEN',
      headline: 'Parkeringsförbud gäller nu',
      recommendation: 'Flytta bilen så snart som möjligt.',
      nextRisk,
      nextRiskText: nextRisk?.message ?? null,
      nextActionAt: null,
      servicedayText: formatServicedayWindow(active),
      allowedText: input.allowedText,
      feeText: input.feeText,
      boendeText: input.boendeText,
    };
  }

  let nextRisk: NextRisk = null;
  for (const window of input.servicedayWindows) {
    const startsAt = findNextOccurrenceInStockholm(input.now, window.weekdayIndex, window.startMin);
    if (!startsAt) continue;
    const endsAt = new Date(startsAt.getTime() + (window.endMin - window.startMin) * 60 * 1000);
    const candidate: NextRisk = {
      type: 'SERVICEDAY',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      message: '',
    };
    if (!nextRisk || new Date(candidate.startsAt).getTime() < new Date(nextRisk.startsAt).getTime()) {
      nextRisk = candidate;
    }
  }

  if (nextRisk) {
    const startDate = new Date(nextRisk.startsAt);
    const endDate = new Date(nextRisk.endsAt);
    const startParts = getStockholmDateParts(startDate);
    const endParts = getStockholmDateParts(endDate);
    const daysAway = diffCalendarDaysStockholm(input.now, startDate);
    nextRisk.message =
      `gatusopning ${dayLabel(startParts.weekdayIndex).toLowerCase()} ` +
      `${formatClock(startParts.minuteOfDay)}-${formatClock(endParts.minuteOfDay)} (${describeDaysAway(daysAway)})`;
  }

  return {
    statusNow: input.servicedayWindows.length > 0 || input.feeText || input.allowedText ? 'OK' : 'UNKNOWN',
    headline:
      input.servicedayWindows.length > 0 || input.feeText || input.allowedText
        ? 'Du får stå här just nu'
        : 'Kan inte avgöra just nu',
    recommendation: nextRisk ? 'Sätt en påminnelse innan nästa servicedag.' : 'Visa schema för att dubbelkolla tider.',
    nextRisk,
    nextRiskText: nextRisk?.message ?? null,
    nextActionAt: nextRisk ? new Date(new Date(nextRisk.startsAt).getTime() - 30 * 60 * 1000).toISOString() : null,
    servicedayText: input.servicedayWindows.length > 0 ? formatServicedayWindow(input.servicedayWindows[0]) : null,
    allowedText: input.allowedText,
    feeText: input.feeText,
    boendeText: input.boendeText,
  };
}

function collectLngLatPairs(value: unknown, out: Array<[number, number]>): void {
  if (!Array.isArray(value)) {
    return;
  }

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

function minDistanceToFeatureMeters(
  feature: GenericFeature,
  lat: number | null,
  lng: number | null,
): number | null {
  if (lat === null || lng === null) {
    return null;
  }
  const coords = feature.geometry?.coordinates;
  const pairs: Array<[number, number]> = [];
  collectLngLatPairs(coords, pairs);
  if (pairs.length === 0) {
    return null;
  }

  let min = Number.POSITIVE_INFINITY;
  for (const [featureLng, featureLat] of pairs) {
    const dist = haversineMeters(lat, lng, featureLat, featureLng);
    if (dist < min) {
      min = dist;
    }
  }
  return Number.isFinite(min) ? min : null;
}

function extractCollectionFromRaw(rawJson: unknown): { collection: FeatureCollectionLike | null; wrapperKey: string | null } {
  if (!isFeatureCollectionLike(rawJson)) {
    return { collection: null, wrapperKey: null };
  }

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

function extractDistrictFromRawJson(rawJson: unknown): string | null {
  const extracted = extractCollectionFromRaw(rawJson);
  const features = Array.isArray(extracted.collection?.features)
    ? (extracted.collection?.features as GenericFeature[])
    : [];

  const districts: string[] = [];
  for (const feature of features) {
    const props = feature.properties ?? {};
    const cityDistrict = props.CITY_DISTRICT;
    const parkingDistrict = props.PARKING_DISTRICT;
    if (typeof cityDistrict === 'string' && cityDistrict.trim().length > 0) {
      districts.push(cityDistrict);
    }
    if (typeof parkingDistrict === 'string' && parkingDistrict.trim().length > 0) {
      districts.push(parkingDistrict);
    }
  }

  return pickBestDistrict(districts);
}

function rebuildRawWithFilteredFeatures(
  originalRaw: unknown,
  filteredFeatures: GenericFeature[],
  wrapperKey: string | null,
): unknown {
  if (!isFeatureCollectionLike(originalRaw)) {
    return originalRaw;
  }

  const base = originalRaw as Record<string, unknown>;
  const patchCounts = (value: Record<string, unknown>) => ({
    ...value,
    features: filteredFeatures,
    numberMatched: filteredFeatures.length,
    numberReturned: filteredFeatures.length,
    totalFeatures: filteredFeatures.length,
  });

  if (!wrapperKey) {
    return patchCounts(base);
  }

  const nested = base[wrapperKey];
  if (!isFeatureCollectionLike(nested)) {
    return originalRaw;
  }

  return {
    ...base,
    [wrapperKey]: patchCounts(nested as Record<string, unknown>),
  };
}

function filterRawJsonToBestAddress(input: {
  rawJson: unknown;
  streetName: string | null;
  houseNumber: string | null;
  lat: number | null;
  lng: number | null;
}): { filteredRawJson: unknown; selectedAddress: string | null } {
  const extracted = extractCollectionFromRaw(input.rawJson);
  const collection = extracted.collection;
  if (!collection || !Array.isArray(collection.features)) {
    return {
      filteredRawJson: input.rawJson,
      selectedAddress: null,
    };
  }

  const features = collection.features.filter(
    (item): item is GenericFeature => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  );
  if (features.length === 0) {
    return {
      filteredRawJson: input.rawJson,
      selectedAddress: null,
    };
  }

  const scored = features
    .map((feature) => {
      const address = getFeatureAddress(feature);
      const score = address ? addressMatchScore(`Plats: ${address}`, input.streetName, input.houseNumber) : 0;
      return { feature, address, score };
    })
    .sort((a, b) => b.score - a.score);

  const bestScore = scored[0]?.score ?? 0;
  if (bestScore > 0) {
    const best = scored.filter((row) => row.score === bestScore);
    const preferred = best.find((row) => row.address && input.houseNumber && normalizeCompact(row.address).includes(normalizeCompact(input.houseNumber)));
    const selectedAddress = preferred?.address ?? best[0]?.address ?? null;
    const selectedFeatures = selectedAddress
      ? best
          .filter((row) => row.address && normalizeCompact(row.address) === normalizeCompact(selectedAddress))
          .map((row) => row.feature)
      : best.map((row) => row.feature);

    return {
      filteredRawJson: rebuildRawWithFilteredFeatures(input.rawJson, selectedFeatures, extracted.wrapperKey),
      selectedAddress,
    };
  }

  const withDistance = features
    .map((feature) => ({
      feature,
      address: getFeatureAddress(feature),
      distanceM: minDistanceToFeatureMeters(feature, input.lat, input.lng),
    }))
    .filter((row) => row.distanceM !== null)
    .sort((a, b) => (a.distanceM ?? Number.POSITIVE_INFINITY) - (b.distanceM ?? Number.POSITIVE_INFINITY));

  if (withDistance.length > 0) {
    const nearest = withDistance[0];
    const selectedAddress = nearest?.address ?? null;
    const selectedFeatures = selectedAddress
      ? features.filter((feature) => {
          const address = getFeatureAddress(feature);
          if (!address) return false;
          return normalizeCompact(address) === normalizeCompact(selectedAddress);
        })
      : [nearest.feature];

    return {
      filteredRawJson: rebuildRawWithFilteredFeatures(input.rawJson, selectedFeatures, extracted.wrapperKey),
      selectedAddress,
    };
  }

  return {
    filteredRawJson: rebuildRawWithFilteredFeatures(input.rawJson, [features[0]], extracted.wrapperKey),
    selectedAddress: getFeatureAddress(features[0]),
  };
}

async function reverseGeocodeAddress(lat: number, lng: number): Promise<GeocodedAddress> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('addressdetails', '1');

  const response = await fetch(url.toString(), {
    cache: 'no-store',
    headers: {
      'user-agent': 'ParkSignal/0.1 (vehicle-card-reverse-geocode)',
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    return {
      displayName: null,
      street: null,
      houseNumber: null,
      district: null,
    };
  }

  const json = (await response.json()) as ReverseGeocodeResponse;
  const street = json.address?.road ?? json.address?.pedestrian ?? json.address?.footway ?? json.address?.street ?? null;
  const houseNumber = json.address?.house_number ?? null;
  const district =
    json.address?.suburb ??
    json.address?.neighbourhood ??
    json.address?.city_district ??
    json.address?.city ??
    json.address?.town ??
    null;
  return {
    displayName: json.display_name ?? null,
    street,
    houseNumber,
    district,
  };
}

export async function GET(req: Request) {
  if (!DEV_USER_ID) {
    return new Response('Missing DEV_USER_ID', { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({
    vehicleId: searchParams.get('vehicleId'),
    now: searchParams.get('now') ?? undefined,
  });

  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const effectiveNow = parsed.data.now ? new Date(parsed.data.now) : new Date();
  if (!Number.isFinite(effectiveNow.getTime())) {
    return new Response('Invalid now query param. Use ISO datetime.', { status: 400 });
  }

  const { data: vehicle, error: vehicleError } = (await supabaseAdmin
    .from('vehicles')
    .select('id,nickname,vin,user_id,external_vehicle_id')
    .eq('id', parsed.data.vehicleId)
    .eq('user_id', DEV_USER_ID)
    .maybeSingle()) as {
    data: VehicleRow | null;
    error: { message: string } | null;
  };

  if (vehicleError) {
    return new Response(`DB error: ${vehicleError.message}`, { status: 500 });
  }

  if (!vehicle) {
    return new Response('Vehicle not found', { status: 404 });
  }

  const [latestTelemetryResult, latestEventsResult] = await Promise.all([
    supabaseAdmin
      .from('vehicle_telemetry_last')
      .select('ts,lat,lng,speed_kph,shift_state')
      .eq('vehicle_id', vehicle.id)
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('vehicle_events')
      .select('id,type,ts,lat,lng,speed_kph,shift_state,meta')
      .eq('vehicle_id', vehicle.id)
      .order('ts', { ascending: false })
      .limit(10),
  ]);

  const latestTelemetry = (latestTelemetryResult.data ?? null) as LatestTelemetryRow | null;
  const telemetryError = latestTelemetryResult.error as { message: string } | null;
  const latestEvents = (latestEventsResult.data ?? null) as VehicleEventRow[] | null;
  const eventsError = latestEventsResult.error as { message: string } | null;

  if (telemetryError) {
    return new Response(`DB error: ${telemetryError.message}`, { status: 500 });
  }
  if (eventsError) {
    return new Response(`DB error: ${eventsError.message}`, { status: 500 });
  }

  const events = latestEvents ?? [];
  const latestParked = events.find((event) => event.type === 'PARKED') ?? null;

  let parkedCard: {
    eventId: string;
    ts: string;
    checkedAt: string;
    address: string | null;
    lat: number | null;
    lng: number | null;
    statusSummary: StatusSummary;
    ruleHits: Array<{ severity: string; title: string; shortText: string; rawJson: unknown }>;
    allParkingRules: Array<{ title: string; severity: string; summary: string }>;
    ruleOverview: RuleOverview;
    weeklySchedule: WeeklyScheduleDay[];
    debugRuleHits: RuleHitRow[];
  } | null = null;

  if (latestParked) {
    const lat = toNumber(latestParked.lat);
    const lng = toNumber(latestParked.lng);
    const geocodedAddress =
      lat !== null && lng !== null
        ? await reverseGeocodeAddress(lat, lng)
        : {
            displayName: null,
            street: null,
            houseNumber: null,
            district: null,
          };
    const address = formatShortAddress(geocodedAddress);

    const { data: ruleHitsRows, error: ruleHitsError } = (await supabaseAdmin
      .from('vehicle_event_rule_hits')
      .select('severity,rule_type,summary,raw_json')
      .eq('vehicle_event_id', latestParked.id)
      .order('created_at', { ascending: false })) as {
      data: RuleHitRow[] | null;
      error: { message: string } | null;
    };

    if (ruleHitsError) {
      return new Response(`DB error: ${ruleHitsError.message}`, { status: 500 });
    }

    const ruleDistrict = pickBestDistrict((ruleHitsRows ?? []).map((hit) => extractDistrictFromRawJson(hit.raw_json)).filter((value): value is string => Boolean(value)));
    if (ruleDistrict) {
      geocodedAddress.district = ruleDistrict;
    }

    const presentedHits = (ruleHitsRows ?? []).map((hit) => {
      const addressFiltered = filterRawJsonToBestAddress({
        rawJson: hit.raw_json,
        streetName: geocodedAddress.street,
        houseNumber: geocodedAddress.houseNumber,
        lat,
        lng,
      });

      const presentation = buildRulePresentation({
        rule_type: hit.rule_type,
        severity: hit.severity,
        summary: hit.summary,
        raw_json: addressFiltered.filteredRawJson,
      });

      const scoredRules = dedupeStrings(
        presentation.allRules.filter((line) => lineMatchesAddress(line, geocodedAddress.street, geocodedAddress.houseNumber)),
      ).map((line) => ({
        line,
        score: addressMatchScore(line, geocodedAddress.street, geocodedAddress.houseNumber),
      }));
      const bestScore = scoredRules.reduce((acc, item) => Math.max(acc, item.score), 0);
      const bestRules = scoredRules
        .filter((item) => (bestScore > 0 ? item.score === bestScore : item.score > 0))
        .map((item) => item.line);

      return {
        severity: hit.severity,
        title: presentation.title,
        shortText: presentation.shortText,
        rawJson: addressFiltered.filteredRawJson,
        allRules: dedupeStrings(bestRules),
        fallbackSummary: hit.summary,
        ruleType: hit.rule_type,
        selectedAddress: addressFiltered.selectedAddress,
      };
    });

    const filteredPresentedHits = presentedHits
      .map((hit) => {
        if (hit.allRules.length > 0) {
          return {
            ...hit,
            shortText: hit.allRules[0] ?? hit.shortText,
          };
        }
        return null;
      })
      .filter((hit): hit is NonNullable<typeof hit> => hit !== null);

    const filteredRuleHitsForStatus: RuleHitRow[] = filteredPresentedHits.map((hit) => ({
      severity: hit.severity,
      rule_type: hit.ruleType,
      summary: hit.shortText || hit.fallbackSummary,
      raw_json: hit.rawJson,
    }));

    const servicedayWindows = extractServicedayWindows(filteredRuleHitsForStatus);
    const allowedText = formatAllowedWindow(filteredRuleHitsForStatus);
    const rateDetails = parseParkingRateDetails(filteredRuleHitsForStatus);
    const statusSummary = buildStatusSummary({
      now: effectiveNow,
      servicedayWindows,
      allowedText,
      feeText: rateDetails.feeText,
      boendeText: rateDetails.boendeText,
    });

    const allParkingRules = filteredPresentedHits.flatMap((hit) => {
      if (hit.allRules.length === 0) {
        return [
          {
            title: hit.title,
            severity: hit.severity,
            summary: hit.shortText,
          },
        ];
      }

      return hit.allRules.map((line) => ({
        title: hit.title,
        severity: hit.severity,
        summary: line,
      }));
    });

    const dedupedParkingRules: Array<{ title: string; severity: string; summary: string }> = [];
    const seenRuleKeys = new Set<string>();
    for (const rule of allParkingRules) {
      const key = `${rule.title}\u0000${rule.severity}\u0000${rule.summary}`;
      if (seenRuleKeys.has(key)) continue;
      seenRuleKeys.add(key);
      dedupedParkingRules.push(rule);
    }

    const ruleOverview: RuleOverview = { forbidden: [], paid: [], free: [] };
    for (const rule of dedupedParkingRules) {
      const bucket = classifyRuleLine(rule.summary, rule.title);
      ruleOverview[bucket].push(rule.summary);
    }
    ruleOverview.forbidden = dedupeStrings(ruleOverview.forbidden);
    ruleOverview.paid = dedupeStrings(ruleOverview.paid);
    ruleOverview.free = dedupeStrings(ruleOverview.free);

    parkedCard = {
      eventId: latestParked.id,
      ts: latestParked.ts,
      checkedAt: effectiveNow.toISOString(),
      address,
      lat,
      lng,
      statusSummary,
      ruleHits: filteredPresentedHits.map((hit) => ({
        severity: hit.severity,
        title: hit.title,
        shortText: hit.shortText,
        rawJson: hit.rawJson,
      })),
      allParkingRules: dedupedParkingRules,
      ruleOverview,
      weeklySchedule: buildWeeklyScheduleFromRaw(filteredRuleHitsForStatus),
      debugRuleHits: filteredPresentedHits.map((hit) => ({
        severity: hit.severity,
        rule_type: hit.ruleType,
        summary: hit.shortText || hit.fallbackSummary,
        raw_json: hit.rawJson,
      })),
    };
  }

  return Response.json({
    vehicle: {
      id: vehicle.id,
      nickname: vehicle.nickname ?? 'Min bil',
      vinSuffix: vinSuffix(vehicle.vin),
    },
    latestTelemetry:
      latestTelemetry && latestTelemetry.ts
        ? {
            ts: latestTelemetry.ts,
            lat: toNumber(latestTelemetry.lat),
            lng: toNumber(latestTelemetry.lng),
            speed_kph: toNumber(latestTelemetry.speed_kph),
            shift_state: latestTelemetry.shift_state,
          }
        : null,
    latestEvents: events,
    parkedCard,
  });
}
