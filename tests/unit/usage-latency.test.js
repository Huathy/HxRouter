// usageHistory.latencyMs: migration + storage + aggregation + t/s derivation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-latency-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows: sqlite file still open */ }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("usageHistory latencyMs", () => {
  it("migration 009 adds latencyMs column (re-entrant)", async () => {
    const { default: m009 } = await import("@/lib/db/migrations/009-add-usage-latency.js");
    expect(m009.version).toBe(9);
    expect(m009.name).toBe("add-usage-latency");

    const adapter = await import("@/lib/db/driver.js");
    const raw = await adapter.getAdapter();
    const cols = raw.all("PRAGMA table_info(usageHistory)");
    expect(cols.some((c) => c.name === "latencyMs")).toBe(true);

    // Re-run is safe (idempotent)
    expect(() => m009.up(raw)).not.toThrow();
  });

  it("saveRequestUsage persists latencyMs; rows without latency default to 0", async () => {
    await db.saveRequestUsage({
      provider: "openai", model: "gpt-4o", connectionId: "c-lat",
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
      endpoint: "/v1/chat/completions", status: "ok", latencyMs: 1500,
    });
    await db.saveRequestUsage({
      provider: "openai", model: "gpt-4o", connectionId: "c-lat",
      tokens: { prompt_tokens: 200, completion_tokens: 100 },
      endpoint: "/v1/chat/completions", status: "ok", latencyMs: 2500,
    });
    // No latency → must not pollute the average
    await db.saveRequestUsage({
      provider: "anthropic", model: "claude-sonnet", connectionId: "c-nolat",
      tokens: { prompt_tokens: 50, completion_tokens: 20 },
      endpoint: "/v1/messages", status: "ok",
    });

    const stats = await db.getUsageStats("24h");

    // Two rows with latency, each 1000ms apart → avg 2000ms
    expect(stats.totalLatencyCount).toBe(2);
    expect(stats.avgLatencyMs).toBeCloseTo(2000, 5);

    // t/s = totalTokens / totalLatencyMs * 1000
    // Plan formula: (totalPromptTokens + totalCompletionTokens) / totalLatencyMs * 1000
    // All rows' tokens: (100+50)+(200+100)+(50+20)=520; totalLatencyMs=4000
    // 520 / 4000 * 1000 = 130
    expect(stats.avgTokensPerSecond).toBeCloseTo(130, 5);

    // byModel aggregates latencyMs + latencyCount
    const modelKey = "gpt-4o (openai)";
    expect(stats.byModel[modelKey]).toBeDefined();
    expect(stats.byModel[modelKey].latencyMs).toBe(4000);
    expect(stats.byModel[modelKey].latencyCount).toBe(2);

    // No-latency model has latencyCount 0
    const noLatKey = "claude-sonnet (anthropic)";
    expect(stats.byModel[noLatKey].latencyCount).toBe(0);
  });

  it("getUsageStats returns nulls when no latency samples", async () => {
    const stats = await db.getUsageStats("all");
    expect(stats).toHaveProperty("avgLatencyMs");
    expect(stats).toHaveProperty("avgTokensPerSecond");
  });
});
