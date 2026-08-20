// Shared validation for scalar card fields. Kept separate from card.ts so
// parsers can report findings while mutation paths reject before writing.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/;

/** A real UTC calendar date, or an RFC3339-style UTC datetime. */
export function validCardDate(value: string): boolean {
  if (DATE_ONLY_RE.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  const match = UTC_DATETIME_RE.exec(value);
  if (!match || !validCardDate(match[1]!)) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] === undefined ? 0 : Number(match[4]);
  return hour <= 23 && minute <= 59 && second <= 59 && !Number.isNaN(Date.parse(value));
}

export function validEstimate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function validHill(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100;
}
