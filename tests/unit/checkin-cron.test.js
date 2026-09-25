import { describe, expect, it } from "vitest";
import { getNextCheckinRun, parseCheckinCron } from "../../src/lib/checkin/cron.js";

describe("checkin cron", () => {
  it("validates five-field cron expressions", () => {
    expect(parseCheckinCron("0 8 * * *").ok).toBe(true);
    expect(parseCheckinCron("*/15 8-18 * * 1-5").ok).toBe(true);
    expect(parseCheckinCron("61 * * * *").ok).toBe(false);
    expect(parseCheckinCron("* * *").ok).toBe(false);
  });

  it("calculates the next timezone-aware run", () => {
    const next = getNextCheckinRun("0 8 * * *", "Asia/Shanghai", Date.parse("2026-09-24T23:00:00Z"));
    expect(new Date(next).toISOString()).toBe("2026-09-25T00:00:00.000Z");
  });

  it("uses standard OR semantics for day-of-month and weekday", () => {
    const next = getNextCheckinRun("0 0 1 * 1", "UTC", Date.parse("2026-09-01T00:00:00Z"));
    expect(new Date(next).toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("finds leap-day schedules across multi-year gaps", () => {
    const next = getNextCheckinRun("0 0 29 2 *", "UTC", Date.parse("2025-03-01T00:00:00Z"));
    expect(new Date(next).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("rejects invalid timezones", () => {
    expect(() => getNextCheckinRun("0 8 * * *", "Not/A_Timezone", Date.now())).toThrow("Invalid timezone");
  });
});
