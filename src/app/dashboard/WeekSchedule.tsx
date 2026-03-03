'use client';

type Weekday = 'Mån' | 'Tis' | 'Ons' | 'Tor' | 'Fre' | 'Lör' | 'Sön';
type BlockKind = 'FREE' | 'FEE' | 'FORBIDDEN';

type WeekScheduleBlock = {
  start: string;
  end: string;
  kind: BlockKind;
  label: string;
};

type WeekScheduleDay = {
  weekday: Weekday;
  blocks: WeekScheduleBlock[];
};

type LegacyDay = {
  day: Weekday;
  rows: Array<{
    from: string;
    to: string;
    label: string;
  }>;
};

type Props = {
  schedule?: WeekScheduleDay[] | LegacyDay[] | null;
};

const WEEKDAYS: Weekday[] = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];

function parseTimeToMinutes(value: string): number {
  const trimmed = value.trim();
  if (trimmed === '24') return 24 * 60;

  const hhmm = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const hh = Number.parseInt(hhmm[1] ?? '0', 10);
    const mm = Number.parseInt(hhmm[2] ?? '0', 10);
    if (Number.isFinite(hh) && Number.isFinite(mm)) {
      return Math.max(0, Math.min(24 * 60, hh * 60 + mm));
    }
  }

  const hh = Number.parseInt(trimmed, 10);
  if (Number.isFinite(hh)) {
    return Math.max(0, Math.min(24 * 60, hh * 60));
  }

  return 0;
}

function normalizeBlockKind(label: string): BlockKind {
  const normalized = label.toLowerCase();
  if (normalized.includes('forbud') || normalized.includes('förbud') || normalized.includes('🚫')) {
    return 'FORBIDDEN';
  }
  if (normalized.includes('kr') || normalized.includes('avgift') || normalized.includes('taxa')) {
    return 'FEE';
  }
  return 'FREE';
}

function minuteToDisplay(value: string): string {
  const mins = parseTimeToMinutes(value);
  const hh = Math.floor(mins / 60)
    .toString()
    .padStart(2, '0');
  const mm = (mins % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function normalizeSchedule(input: Props['schedule']): WeekScheduleDay[] {
  if (!input || input.length === 0) return [];

  const first = input[0] as unknown;
  const isAlreadyNormalized =
    Boolean(first) &&
    typeof first === 'object' &&
    'weekday' in (first as Record<string, unknown>) &&
    'blocks' in (first as Record<string, unknown>);

  if (isAlreadyNormalized) {
    return input as WeekScheduleDay[];
  }

  const legacy = input as LegacyDay[];
  return legacy.map((day) => ({
    weekday: day.day,
    blocks: (day.rows ?? []).map((row) => ({
      start: minuteToDisplay(row.from),
      end: minuteToDisplay(row.to),
      kind: normalizeBlockKind(row.label),
      label: row.label,
    })),
  }));
}

function overlaps(a: WeekScheduleBlock, b: WeekScheduleBlock): boolean {
  const aStart = parseTimeToMinutes(a.start);
  const aEnd = parseTimeToMinutes(a.end);
  const bStart = parseTimeToMinutes(b.start);
  const bEnd = parseTimeToMinutes(b.end);
  return aStart < bEnd && bStart < aEnd;
}

function sortBlocks(blocks: WeekScheduleBlock[]): WeekScheduleBlock[] {
  const priority = (kind: BlockKind): number => {
    if (kind === 'FORBIDDEN') return 0;
    if (kind === 'FEE') return 1;
    return 2;
  };

  return [...blocks].sort((a, b) => {
    const aStart = parseTimeToMinutes(a.start);
    const bStart = parseTimeToMinutes(b.start);
    if (overlaps(a, b)) {
      const p = priority(a.kind) - priority(b.kind);
      if (p !== 0) return p;
    }
    if (aStart !== bStart) return aStart - bStart;
    const aEnd = parseTimeToMinutes(a.end);
    const bEnd = parseTimeToMinutes(b.end);
    return aEnd - bEnd;
  });
}

function getStockholmNow(): { weekday: Weekday; minuteOfDay: number } {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Stockholm',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(new Date());
  let weekdayShort = 'Mon';
  let hour = 0;
  let minute = 0;

  for (const part of parts) {
    if (part.type === 'weekday') weekdayShort = part.value;
    if (part.type === 'hour') hour = Number.parseInt(part.value, 10);
    if (part.type === 'minute') minute = Number.parseInt(part.value, 10);
  }

  const weekdayMap: Record<string, Weekday> = {
    Mon: 'Mån',
    Tue: 'Tis',
    Wed: 'Ons',
    Thu: 'Tor',
    Fri: 'Fre',
    Sat: 'Lör',
    Sun: 'Sön',
  };

  return {
    weekday: weekdayMap[weekdayShort] ?? 'Mån',
    minuteOfDay: hour * 60 + minute,
  };
}

function isNowBlock(weekday: Weekday, block: WeekScheduleBlock, now: { weekday: Weekday; minuteOfDay: number }): boolean {
  if (weekday !== now.weekday) return false;
  const start = parseTimeToMinutes(block.start);
  const end = parseTimeToMinutes(block.end);
  return now.minuteOfDay >= start && now.minuteOfDay < end;
}

function chipClass(kind: BlockKind, isNow: boolean): string {
  const base = 'week-chip';
  const kindClass =
    kind === 'FORBIDDEN' ? 'week-chip-forbidden' : kind === 'FEE' ? 'week-chip-fee' : 'week-chip-free';
  return `${base} ${kindClass}${isNow ? ' week-chip-now' : ''}`;
}

export default function WeekSchedule({ schedule }: Props) {
  const normalized = normalizeSchedule(schedule);
  if (normalized.length === 0) {
    return <p className="hint">Inget veckoschema tillgängligt.</p>;
  }

  const byDay = new Map<Weekday, WeekScheduleDay>();
  for (const day of normalized) {
    byDay.set(day.weekday, day);
  }

  const now = getStockholmNow();

  return (
    <div className="week-schedule">
      {WEEKDAYS.map((weekday) => {
        const day = byDay.get(weekday);
        const blocks = sortBlocks(day?.blocks ?? []);
        const isToday = weekday === now.weekday;
        return (
          <div className={`week-row${isToday ? ' week-row-today' : ''}`} key={weekday}>
            <div className="week-day-label">
              <strong>{weekday}</strong>
              {isToday ? <span className="today-badge">Idag</span> : null}
            </div>
            <div className="week-chips">
              {blocks.length === 0 ? (
                <span className="week-empty-chip">Inga tider</span>
              ) : (
                blocks.map((block, idx) => {
                  const nowActive = isNowBlock(weekday, block, now);
                  return (
                    <span className={chipClass(block.kind, nowActive)} key={`${weekday}-${idx}`}>
                      {block.start}–{block.end} {block.label}
                    </span>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
