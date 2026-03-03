export type ParkingStatus = 'OK' | 'RISK' | 'FORBIDDEN';

export type ParkingStatusRuleHitInput = {
  rule_type: string;
  severity: string;
  summary: string;
  raw_json: unknown;
};

export type ParkingStatusSummary = {
  status: ParkingStatus;
  headline: string;
  recommendation: string;
  details: Array<{ title: string; text: string }>;
  nextActionAt?: string | null;
};

type ParkingStatusInput = {
  address: string | null;
  parkedEvent: {
    ts: string;
    lat: number | null;
    lng: number | null;
  };
  ruleHits: ParkingStatusRuleHitInput[];
  now: Date;
};

type PrimitiveField = {
  path: string;
  raw: unknown;
  value: string;
};

function normalizeString(value: unknown): string | null {
  if (typeof value === 'string') {
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'ja' : 'nej';
  }
  return null;
}

export function ruleTypeTitle(ruleType: string): string {
  if (ruleType === 'servicedagar') {
    return 'Gatusopning / servicedag';
  }
  if (ruleType === 'ptillaten') {
    return 'Tillåten parkering';
  }
  return ruleType;
}

export function severityLabel(severity: string): string {
  if (severity === 'CRITICAL') return 'Förbjuden';
  if (severity === 'WARN') return 'Varning';
  return 'Info';
}

function hasForbiddenHint(hits: ParkingStatusRuleHitInput[]): boolean {
  return hits.some((hit) => hit.severity === 'CRITICAL');
}

function normalizeDay(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const map: Record<string, string> = {
    mon: 'måndag',
    monday: 'måndag',
    mandag: 'måndag',
    'måndag': 'måndag',
    tue: 'tisdag',
    tuesday: 'tisdag',
    tisdag: 'tisdag',
    wed: 'onsdag',
    wednesday: 'onsdag',
    onsdag: 'onsdag',
    thu: 'torsdag',
    thursday: 'torsdag',
    torsdag: 'torsdag',
    fri: 'fredag',
    friday: 'fredag',
    fredag: 'fredag',
    sat: 'lördag',
    saturday: 'lördag',
    lordag: 'lördag',
    lördag: 'lördag',
    sun: 'söndag',
    sunday: 'söndag',
    sondag: 'söndag',
    söndag: 'söndag',
  };

  if (map[normalized]) {
    return map[normalized];
  }

  const numberDay = Number.parseInt(normalized, 10);
  if (Number.isFinite(numberDay)) {
    if (numberDay === 1) return 'måndag';
    if (numberDay === 2) return 'tisdag';
    if (numberDay === 3) return 'onsdag';
    if (numberDay === 4) return 'torsdag';
    if (numberDay === 5) return 'fredag';
    if (numberDay === 6) return 'lördag';
    if (numberDay === 7 || numberDay === 0) return 'söndag';
  }

  return null;
}

function dayPlural(day: string): string {
  return `${day}ar`;
}

function parseMinuteValue(raw: unknown): number | null {
  let numeric: number | null = null;

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    numeric = Math.round(raw);
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d{1,4}$/.test(trimmed)) {
      return null;
    }
    numeric = Number.parseInt(trimmed, 10);
  } else {
    return null;
  }

  if (numeric === null || !Number.isFinite(numeric) || numeric < 0) {
    return null;
  }

  if (numeric === 2400) {
    return 0;
  }

  // Stockholm LTF often uses HHMM format: 600 => 06:00, 1900 => 19:00.
  if (numeric >= 100) {
    const hh = Math.floor(numeric / 100);
    const mm = numeric % 100;
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      return hh * 60 + mm;
    }
  }

  // Fallback for minute-of-day encoding.
  if (numeric <= 1440) {
    return numeric;
  }

  return null;
}

function parseTaxaValue(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }

  if (typeof raw !== 'string') {
    return null;
  }

  const cleaned = raw.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return null;
  }

  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMinutes(value: number): string {
  const normalized = value === 1440 ? 0 : value;
  const hh = Math.floor(normalized / 60)
    .toString()
    .padStart(2, '0');
  const mm = (normalized % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatTaxa(value: number): string {
  if (Number.isInteger(value)) {
    return `${value}`;
  }
  return value.toFixed(2).replace('.', ',');
}

function collectRecordArrays(value: unknown, out: Array<Record<string, unknown>[]>, depth = 0): void {
  if (depth > 6) return;

  if (Array.isArray(value)) {
    const objects = value.filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
    );
    if (objects.length > 0) {
      out.push(objects);
    }
    for (const item of value) {
      collectRecordArrays(item, out, depth + 1);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const nested of Object.values(record)) {
    collectRecordArrays(nested, out, depth + 1);
  }
}

function flattenPrimitiveFields(value: unknown, out: PrimitiveField[], prefix = '', depth = 0): void {
  if (depth > 6) return;

  if (!value || typeof value !== 'object') {
    const normalized = normalizeString(value);
    if (normalized && prefix) {
      out.push({ path: prefix, raw: value, value: normalized });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenPrimitiveFields(item, out, `${prefix}[${index}]`, depth + 1);
    });
    return;
  }

  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    flattenPrimitiveFields(nested, out, nextPrefix, depth + 1);
  }
}

function selectFieldValues(fields: PrimitiveField[], pattern: RegExp, limit = 3): PrimitiveField[] {
  const values: PrimitiveField[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    if (!pattern.test(field.path)) continue;
    const lowered = field.path.toLowerCase();
    if (lowered.includes('apikey')) continue;
    if (lowered.includes('token')) continue;

    const key = `${field.path}:${field.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(field);

    if (values.length >= limit) {
      break;
    }
  }

  return values;
}

function genericSummaryToSwedish(ruleType: string, summary: string): string {
  const match = summary.match(/Found\s+(\d+)\s+/i);
  if (match) {
    const n = Number.parseInt(match[1] ?? '0', 10);
    if (ruleType === 'servicedagar') {
      return `${n} servicedagsregler hittades nära adressen.`;
    }
    if (ruleType === 'ptillaten') {
      return `${n} tillåtna parkeringsregler hittades nära adressen.`;
    }
  }

  if (/No\s+/i.test(summary)) {
    if (ruleType === 'servicedagar') {
      return 'Inga servicedagsregler hittades vid senaste kontrollen.';
    }
    if (ruleType === 'ptillaten') {
      return 'Inga tillåtna parkeringsregler hittades vid senaste kontrollen.';
    }
  }

  return summary;
}

function dedupe(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const key = line
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\|\s*plats:\s*/g, '|plats:')
      .trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function entryToRuleLine(ruleType: string, entry: Record<string, unknown>): string | null {
  const payload =
    (entry.properties && typeof entry.properties === 'object' ? (entry.properties as Record<string, unknown>) : null) ??
    (entry.attributes && typeof entry.attributes === 'object'
      ? (entry.attributes as Record<string, unknown>)
      : null) ??
    entry;

  const flat: PrimitiveField[] = [];
  flattenPrimitiveFields(payload, flat);

  const explicitText = selectFieldValues(
    flat,
    /(regeltext|foreskrift|föreskrift|beskrivning|description|anmarkning|anmärkning|villkor)$/i,
    1,
  )[0]?.value;

  const dayCandidates = selectFieldValues(flat, /(dag|weekday|veckodag|vardag|helg|week)/i, 3)
    .map((field) => normalizeDay(field.value))
    .filter((value): value is string => Boolean(value));
  const dayText = dayCandidates.length > 0 ? dayPlural(dayCandidates[0]) : null;

  const startField = selectFieldValues(flat, /(start|fran|från|from|begin)/i, 1)[0];
  const endField = selectFieldValues(flat, /(slut|tom|till|to|end)/i, 1)[0];
  const startMin = startField ? parseMinuteValue(startField.raw) : null;
  const endMin = endField ? parseMinuteValue(endField.raw) : null;

  let fallbackStart: number | null = null;
  let fallbackEnd: number | null = null;
  if (startMin === null || endMin === null) {
    const timeCandidates = selectFieldValues(flat, /(tid|time|klock|minut|start|slut|from|tom|till|fran|från)/i, 6)
      .map((field) => parseMinuteValue(field.raw))
      .filter((value): value is number => value !== null);

    if (timeCandidates.length >= 2) {
      fallbackStart = timeCandidates[0] ?? null;
      fallbackEnd = timeCandidates[1] ?? null;
    }
  }

  const startTime = startMin ?? fallbackStart;
  const endTime = endMin ?? fallbackEnd;
  const timeText =
    startTime !== null && endTime !== null
      ? `kl ${formatMinutes(startTime)} - ${formatMinutes(endTime)}`
      : startTime !== null
        ? `från kl ${formatMinutes(startTime)}`
        : null;

  const place =
    selectFieldValues(flat, /(gata|street|adress|address|plats|placering|omrade|område|zon|stracka|sträcka)/i, 1)[0]?.value ??
    null;
  const placeType =
    selectFieldValues(flat, /(vf_plats_typ|platstyp|plats_typ|loading|lastplats|lastzon|zon)$/i, 1)[0]?.value ?? null;
  const vehicleRestriction = selectFieldValues(flat, /(vehicle)$/i, 1)[0]?.value ?? null;
  const otherInfo = selectFieldValues(flat, /(other_info|ovrigt|övrigt)$/i, 1)[0]?.value ?? null;

  const taxField = selectFieldValues(flat, /(taxa|avgift|fee|rate|price|kostnad|belopp|tariff)/i, 1)[0];
  const taxValue = taxField ? parseTaxaValue(taxField.raw) : null;

  const prefix =
    ruleType === 'servicedagar'
      ? 'Parkeringsförbud'
      : taxValue === 0
        ? 'Gratis parkering'
        : taxValue !== null
          ? `Tillåten parkering (Taxa ${formatTaxa(taxValue)})`
          : 'Tillåten parkering';

  const coreParts: string[] = [];
  if (explicitText && explicitText.length >= 6 && !/^found\s+\d+/i.test(explicitText)) {
    coreParts.push(explicitText);
  }

  const whenPart = [dayText, timeText].filter(Boolean).join(' ');
  if (whenPart) {
    coreParts.push(whenPart);
  }

  if (ruleType === 'ptillaten' && taxValue !== null && taxValue > 0 && timeText) {
    coreParts.push(`Avgiftstid ${timeText}`);
  }

  const coreText = coreParts.length > 0 ? `${prefix} ${coreParts.join(' • ')}` : prefix;
  const text = coreText.replace(/\s+/g, ' ').trim();

  if (!text || /found\s+\d+/i.test(text)) {
    return null;
  }

  const extras: string[] = [];
  if (placeType) extras.push(`Typ: ${placeType}`);
  if (vehicleRestriction) extras.push(`Gäller: ${vehicleRestriction}`);
  if (otherInfo && !/servicetid/i.test(otherInfo)) extras.push(otherInfo);

  const suffix = extras.length > 0 ? ` | ${extras.join(' • ')}` : '';
  if (place) {
    return `${text} | Plats: ${place}${suffix}`;
  }
  return `${text}${suffix}`;
}

export function extractRuleLinesFromRaw(ruleType: string, rawJson: unknown, maxLines = 8): string[] {
  const arrays: Array<Record<string, unknown>[]> = [];
  collectRecordArrays(rawJson, arrays);

  const lines: string[] = [];
  for (const records of arrays) {
    for (const record of records) {
      const line = entryToRuleLine(ruleType, record);
      if (!line) continue;
      lines.push(line);
      if (lines.length >= maxLines * 3) {
        break;
      }
    }
    if (lines.length >= maxLines * 3) {
      break;
    }
  }

  return dedupe(lines).slice(0, maxLines);
}

export function buildRulePresentation(hit: ParkingStatusRuleHitInput): {
  title: string;
  shortText: string;
  allRules: string[];
} {
  const parsedLines = extractRuleLinesFromRaw(hit.rule_type, hit.raw_json, 16);
  const shortText = parsedLines[0] ?? genericSummaryToSwedish(hit.rule_type, hit.summary);

  return {
    title: ruleTypeTitle(hit.rule_type),
    shortText,
    allRules: dedupe(parsedLines),
  };
}

export function buildParkingStatusSummary(input: ParkingStatusInput): ParkingStatusSummary {
  const hasServicedagar = input.ruleHits.some((hit) => hit.rule_type === 'servicedagar');
  const hasPtillaten = input.ruleHits.some((hit) => hit.rule_type === 'ptillaten');

  let status: ParkingStatus = 'OK';
  let headline = 'Du får stå här just nu';
  let recommendation = 'Inga kända servicedagar hittades vid senaste kontrollen.';
  let nextActionAt: string | null = null;

  if (hasForbiddenHint(input.ruleHits)) {
    status = 'FORBIDDEN';
    headline = 'Förbjudet: parkering verkar inte tillåten';
    recommendation = 'Flytta bilen så snart som möjligt och dubbelkolla skyltning på plats.';
  } else if (hasServicedagar) {
    status = 'RISK';
    headline = 'Risk: gatusopning kan gälla här';
    recommendation = "Kontrollera förbudstiderna under 'Visa detaljer'.";
    nextActionAt = new Date(input.now.getTime() + 30 * 60 * 1000).toISOString();
  } else if (!hasPtillaten && input.ruleHits.length === 0) {
    status = 'RISK';
    headline = 'Oklar parkeringsstatus';
    recommendation = 'Kunde inte hitta regler för platsen. Kontrollera skyltning på plats.';
  }

  const details = input.ruleHits.map((hit) => {
    const presentation = buildRulePresentation(hit);
    const combined =
      presentation.allRules.length > 0
        ? presentation.allRules.slice(0, 3).join(' • ')
        : genericSummaryToSwedish(hit.rule_type, hit.summary);

    return {
      title: `${presentation.title} - ${severityLabel(hit.severity)}`,
      text: combined,
    };
  });

  if (details.length === 0) {
    details.push({
      title: 'Inga regelträffar',
      text: input.address
        ? `Inga registrerade regelträffar hittades för ${input.address}.`
        : 'Inga registrerade regelträffar hittades vid senaste kontrollen.',
    });
  }

  return {
    status,
    headline,
    recommendation,
    details,
    nextActionAt,
  };
}
