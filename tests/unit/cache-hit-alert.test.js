// Cache hit-rate drop detection.
//
// The two guard tests here are the ones that matter: a sub-threshold bucket and
// a repeated report are the two ways a naive version of this alert becomes
// noise, and noise is worse than no alert because people learn to dismiss it.
import { describe, it, expect } from "vitest";
import {
  detectCacheHitDrop,
  bucketCacheHitByHour,
  cacheBucketKey,
  MIN_REQUESTS_PER_BUCKET,
} from "@/shared/utils/cacheHitAlert";

/** Build a bucket with sane defaults so each test only states what it cares about. */
function bucket(overrides) {
  return { bucketStart: 0, requests: 10, promptTokens: 1000, cachedTokens: 800, hitRate: 0.8, ...overrides };
}

describe("detectCacheHitDrop", () => {
  it("reports ok on a stable series", () => {
    const buckets = Array.from({ length: 8 }, () => bucket());
    const result = detectCacheHitDrop(buckets);
    expect(result.status).toBe("ok");
    expect(result.baselineHitRate).toBeCloseTo(0.8);
  });

  it("reports a drop when the current hour collapses", () => {
    const buckets = [
      ...Array.from({ length: 7 }, () => bucket()),
      bucket({ requests: 40, promptTokens: 4000, cachedTokens: 100, hitRate: 0.025 }),
    ];
    const result = detectCacheHitDrop(buckets);
    expect(result.status).toBe("drop");
    expect(result.current.hitRate).toBeCloseTo(0.025);
    expect(result.baselineHitRate).toBeCloseTo(0.8);
  });

  // Guard 1: minimum sample size.
  it("ignores a bucket below the request minimum", () => {
    const buckets = [
      ...Array.from({ length: 7 }, () => bucket()),
      bucket({ requests: 3, promptTokens: 300, cachedTokens: 0, hitRate: 0 }),
    ];
    const result = detectCacheHitDrop(buckets);
    expect(result.status).toBe("insufficient-data");
    expect(result.reason).toMatch(/below the 5-request minimum/);
  });

  it("honours a custom request minimum", () => {
    const buckets = [
      ...Array.from({ length: 7 }, () => bucket()),
      bucket({ requests: 3, hitRate: 0 }),
    ];
    expect(detectCacheHitDrop(buckets, { minRequests: 3 }).status).toBe("drop");
    expect(detectCacheHitDrop(buckets, { minRequests: 10 }).status).toBe("insufficient-data");
  });

  it("returns null hit rate (not 0) for a bucket with no prompt tokens", () => {
    const buckets = Array.from({ length: 3 }, () => bucket());
    buckets.push(bucket({ requests: 10, promptTokens: 0, cachedTokens: 0, hitRate: null }));
    const result = detectCacheHitDrop(buckets);
    expect(result.status).toBe("insufficient-data");
    expect(result.reason).toMatch(/no prompt tokens/);
  });

  it("uses the median, so one bad prior hour cannot mask the drop", () => {
    const buckets = [
      bucket(), bucket(), bucket(), bucket(), bucket(),
      bucket({ hitRate: 0 }),          // single bad prior hour
      bucket({ hitRate: 0.8 }),
      bucket({ hitRate: 0.02 }),
    ];
    const result = detectCacheHitDrop(buckets);
    expect(result.status).toBe("drop");
    // Median of the prior hours stays high despite the one zero.
    expect(result.baselineHitRate).toBeGreaterThan(0.5);
  });

  it("reports ok rather than dividing by a zero baseline", () => {
    const buckets = [
      ...Array.from({ length: 7 }, () => bucket({ hitRate: 0 })),
      bucket({ hitRate: 0.1 }),
    ];
    const result = detectCacheHitDrop(buckets);
    expect(result.status).toBe("ok");
    expect(result.baselineHitRate).toBe(0);
  });

  it("needs at least two qualifying prior hours", () => {
    const buckets = [
      bucket(),
      bucket({ requests: 1 }),
      bucket({ hitRate: 0.02 }),
    ];
    const result = detectCacheHitDrop(buckets);
    expect(result.status).toBe("insufficient-data");
    expect(result.reason).toMatch(/need at least 2/);
  });

  it("returns insufficient-data for a short series instead of guessing", () => {
    expect(detectCacheHitDrop([]).status).toBe("insufficient-data");
    expect(detectCacheHitDrop([bucket()]).status).toBe("insufficient-data");
    expect(detectCacheHitDrop(null).status).toBe("insufficient-data");
  });

  it("respects a custom drop ratio", () => {
    const buckets = [
      ...Array.from({ length: 7 }, () => bucket({ hitRate: 0.8 })),
      bucket({ hitRate: 0.5 }),
    ];
    expect(detectCacheHitDrop(buckets, { dropRatio: 0.5 }).status).toBe("ok");
    expect(detectCacheHitDrop(buckets, { dropRatio: 0.9 }).status).toBe("drop");
  });

  it("is stable across repeated evaluation of the same series", () => {
    // Guard 2 in effect: the detector is a pure function of its input, so the
    // caller can dedupe on bucketStart and never re-alert for the same hour.
    const buckets = [
      ...Array.from({ length: 7 }, () => bucket()),
      bucket({ hitRate: 0.02 }),
    ];
    const first = detectCacheHitDrop(buckets);
    const second = detectCacheHitDrop(buckets);
    expect(second.status).toBe(first.status);
    expect(second.current.bucketStart).toBe(first.current.bucketStart);
  });
});

describe("bucketCacheHitByHour", () => {
  const now = Date.UTC(2026, 8, 26, 12, 0, 0);
  const bucketMs = 3600000;
  const iso = (ms) => new Date(ms).toISOString();

  it("parses cached tokens out of the tokens JSON blob", () => {
    const rows = [
      { timestamp: iso(now - 10 * 60000), promptTokens: 100, tokens: JSON.stringify({ cached_tokens: 60 }) },
      { timestamp: iso(now - 5 * 60000), promptTokens: 100, tokens: JSON.stringify({ cache_read_input_tokens: 40 }) },
    ];
    const buckets = bucketCacheHitByHour(rows, { now, bucketCount: 2, bucketMs });
    const current = buckets[buckets.length - 1];
    expect(current.requests).toBe(2);
    expect(current.promptTokens).toBe(200);
    expect(current.cachedTokens).toBe(100);
    expect(current.hitRate).toBeCloseTo(0.5);
  });

  it("yields null hit rate for a bucket with no prompt tokens", () => {
    const rows = [{ timestamp: iso(now - 60000), promptTokens: 0, tokens: null }];
    const buckets = bucketCacheHitByHour(rows, { now, bucketCount: 1, bucketMs });
    expect(buckets[0].hitRate).toBeNull();
  });

  it("survives a malformed tokens blob instead of aborting the trend", () => {
    const rows = [
      { timestamp: iso(now - 2 * 60000), promptTokens: 100, tokens: "{not json" },
      { timestamp: iso(now - 60000), promptTokens: 100, tokens: JSON.stringify({ cached_tokens: 25 }) },
    ];
    const buckets = bucketCacheHitByHour(rows, { now, bucketCount: 1, bucketMs });
    expect(buckets[0].requests).toBe(2);
    expect(buckets[0].cachedTokens).toBe(25);
  });

  // The driver decides how the TEXT column arrives, and the same bucketer has to
  // serve every driver: better-sqlite3 yields a string, sql.js a Uint8Array.
  it("reads cached tokens from a binary tokens column", () => {
    const blob = new TextEncoder().encode(JSON.stringify({ cached_tokens: 70 }));
    const rows = [{ timestamp: iso(now - 60000), promptTokens: 100, tokens: blob }];
    const buckets = bucketCacheHitByHour(rows, { now, bucketCount: 1, bucketMs });
    expect(buckets[0].cachedTokens).toBe(70);
  });

  it("accepts an already-parsed tokens object", () => {
    const rows = [{ timestamp: iso(now - 60000), promptTokens: 100, tokens: { cached_tokens: 30 } }];
    const buckets = bucketCacheHitByHour(rows, { now, bucketCount: 1, bucketMs });
    expect(buckets[0].cachedTokens).toBe(30);
  });

  it("drops rows outside the window and unparseable timestamps", () => {
    const rows = [
      { timestamp: iso(now - 10 * bucketMs), promptTokens: 5 },  // too old
      { timestamp: "not-a-date", promptTokens: 5 },
      { timestamp: iso(now - 60000), promptTokens: 10 },
    ];
    const buckets = bucketCacheHitByHour(rows, { now, bucketCount: 3, bucketMs });
    expect(buckets.reduce((n, b) => n + b.requests, 0)).toBe(1);
  });

  it("round-trips into the detector", () => {
    // 6 requests per hour so every bucket clears MIN_REQUESTS_PER_BUCKET; the
    // most recent hour is the one that loses its cache.
    const rows = [];
    for (let h = 8; h >= 1; h--) {
      const cached = h === 1 ? 0 : 800;
      for (let i = 0; i < 6; i++) {
        rows.push({
          timestamp: iso(now - (h - 0.5) * bucketMs + i * 60000),
          promptTokens: 1000,
          tokens: JSON.stringify({ cached_tokens: cached }),
        });
      }
    }
    const buckets = bucketCacheHitByHour(rows, { now, bucketCount: 10, bucketMs });
    expect(buckets.every((b) => b.requests === 0 || b.requests >= MIN_REQUESTS_PER_BUCKET)).toBe(true);

    const result = detectCacheHitDrop(buckets);
    expect(result.status).toBe("drop");
    expect(result.current.hitRate).toBe(0);
  });
});

describe("cacheBucketKey - stable identity for a moving bucket", () => {
  const HOUR = 3600000;

  it("is identical for two polls inside the same hour, so a dismissal sticks", () => {
    // This is the regression: the grid is anchored at request time, so the current
    // (partial) hour's bucketStart moves on every poll. Keying the once-per-bucket
    // dismissal on the raw bucketStart meant the alert a user just dismissed came
    // back on the next 5-minute poll, forever.
    const poll1 = Date.parse("2026-09-26T10:02:00Z");
    const poll2 = Date.parse("2026-09-26T10:07:00Z");
    const key1 = cacheBucketKey(poll1 - HOUR);
    const key2 = cacheBucketKey(poll2 - HOUR);
    expect(key1).toBe(key2);
    expect(key1 % HOUR).toBe(0);
  });

  it("changes once the hour rolls over, so the next distinct drop can surface", () => {
    const before = cacheBucketKey(Date.parse("2026-09-26T10:59:00Z") - HOUR);
    const after = cacheBucketKey(Date.parse("2026-09-26T11:01:00Z") - HOUR);
    expect(after).toBeGreaterThan(before);
  });

  it("returns null for a missing bucket rather than a falsy key that matches nothing", () => {
    expect(cacheBucketKey(undefined)).toBeNull();
    expect(cacheBucketKey(null)).toBeNull();
    expect(cacheBucketKey(NaN)).toBeNull();
  });
});
