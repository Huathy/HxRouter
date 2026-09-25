const FIELD_DEFINITIONS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 },
];

const formatterCache = new Map();

function parseField(field, definition) {
  const values = new Set();
  for (const part of field.split(",")) {
    const [rangePart, stepPart, ...extra] = part.split("/");
    if (extra.length > 0) return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;
    let start = definition.min;
    let end = definition.max;
    if (rangePart !== "*") {
      const bounds = rangePart.split("-");
      if (bounds.length > 2) return null;
      start = Number(bounds[0]);
      end = bounds.length === 2 ? Number(bounds[1]) : start;
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    }
    if (start < definition.min || end > definition.max || start > end) return null;
    for (let value = start; value <= end; value += step) {
      values.add(definition.name === "dayOfWeek" && value === 7 ? 0 : value);
    }
  }
  return values;
}

export function parseCheckinCron(expression) {
  if (typeof expression !== "string") return { ok: false, error: "Cron expression is required" };
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return { ok: false, error: "Cron expression must contain five fields" };
  const parsed = [];
  for (let index = 0; index < fields.length; index += 1) {
    const values = parseField(fields[index], FIELD_DEFINITIONS[index]);
    if (!values || values.size === 0) {
      return { ok: false, error: `Invalid ${FIELD_DEFINITIONS[index].name} field` };
    }
    parsed.push(values);
  }
  return {
    ok: true,
    fields: parsed,
    dayOfMonthWildcard: fields[2] === "*",
    dayOfWeekWildcard: fields[4] === "*",
  };
}

function getFormatter(timezone) {
  if (!formatterCache.has(timezone)) {
    formatterCache.set(timezone, new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }));
  }
  return formatterCache.get(timezone);
}

function getZonedParts(date, timezone) {
  let formatter;
  try {
    formatter = getFormatter(timezone);
  } catch {
    throw new Error("Invalid timezone");
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    minute: parts.minute,
    hour: parts.hour,
    dayOfMonth: parts.day,
    month: parts.month,
    dayOfWeek: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function makeZonedCandidate(year, month, day, hour, minute, timezone) {
  const wallTime = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = wallTime;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getZonedParts(new Date(candidate), timezone);
    const observedWallTime = Date.UTC(parts.year, parts.month - 1, parts.dayOfMonth, parts.hour, parts.minute);
    const adjustment = wallTime - observedWallTime;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  return candidate;
}

function matchesCronDay(parsed, day, weekday) {
  if (parsed.dayOfMonthWildcard) return parsed.fields[4].has(weekday);
  if (parsed.dayOfWeekWildcard) return parsed.fields[2].has(day);
  return parsed.fields[2].has(day) || parsed.fields[4].has(weekday);
}

export function getNextCheckinRun(expression, timezone, from = Date.now()) {
  const parsed = parseCheckinCron(expression);
  if (!parsed.ok) throw new Error(parsed.error);
  const zone = timezone || "UTC";
  const startParts = getZonedParts(new Date(from), zone);
  const firstLocalDate = Date.UTC(startParts.year, startParts.month - 1, startParts.dayOfMonth);
  const limit = 8 * 366 + 2;

  for (let dayOffset = 0; dayOffset < limit; dayOffset += 1) {
    const localDate = new Date(firstLocalDate + dayOffset * DAY_MS);
    const year = localDate.getUTCFullYear();
    const month = localDate.getUTCMonth() + 1;
    const day = localDate.getUTCDate();
    const dayMatches = matchesCronDay(parsed, day, localDate.getUTCDay());
    if (!dayMatches || !parsed.fields[3].has(month)) continue;

    for (const hour of [...parsed.fields[1]].sort((a, b) => a - b)) {
      for (const minute of [...parsed.fields[0]].sort((a, b) => a - b)) {
        const candidate = makeZonedCandidate(year, month, day, hour, minute, zone);
        if (candidate <= from) continue;
        const parts = getZonedParts(new Date(candidate), zone);
        if (
          parts.year === year &&
          parts.month === month &&
          matchesCronDay(parsed, parts.dayOfMonth, parts.dayOfWeek) &&
          parts.hour === hour &&
          parts.minute === minute
        ) return candidate;
      }
    }
  }
  throw new Error("No matching run time found within eight years");
}
