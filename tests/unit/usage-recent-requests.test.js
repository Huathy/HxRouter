// Regression coverage for the Recent Requests data source unification.
// See docs/plans/plan20260920_usage-recent-requests.md.
//
// Before the fix, getActiveRequests() (the lightweight SSE path) read an
// in-memory ring that could be empty/mis-initialized and dropped 0-token error
// rows, so a refresh could show only pending requests. Both paths now read
// buildCompletedRecentRows() straight from usageHistory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;
let usageRepo;

function insertRow(row) {
  const tokens = row.tokens || {};
  adapter.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, httpStatus, tokens, meta)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.timestamp, row.provider, row.model, row.connectionId ?? null, null, null,
      tokens.prompt_tokens || 0, tokens.completion_tokens || 0, 0,
      row.status || "ok", row.httpStatus ?? null, JSON.stringify(tokens), "{}",
    ]
  );
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-recent-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();

  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
  usageRepo = await import("@/lib/db/repos/usageRepo.js");
});

afterAll(() => {
  // node:sqlite keeps the DB file open on Windows; cleanup is best-effort so a
  // locked temp dir never fails the suite.
  if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("buildCompletedRecentRows", () => {
  it("keeps 0-token error rows so 429/502 surface in the recent list", () => {
    insertRow({ timestamp: "2026-09-20T10:00:00.000Z", provider: "openai", model: "gpt-5", status: "error", httpStatus: 429, tokens: {} });

    const hit = usageRepo.buildCompletedRecentRows(adapter, 100).find((r) => r.model === "gpt-5");
    expect(hit).toBeDefined();
    expect(hit.promptTokens).toBe(0);
    expect(hit.completionTokens).toBe(0);
    expect(hit.httpStatus).toBe(429);
  });

  it("drops 0-token success rows (noise)", () => {
    insertRow({ timestamp: "2026-09-20T10:01:00.000Z", provider: "openai", model: "zero-success", status: "ok", httpStatus: 200, tokens: {} });

    const rows = usageRepo.buildCompletedRecentRows(adapter, 100);
    expect(rows.find((r) => r.model === "zero-success")).toBeUndefined();
  });

  it("keeps same-minute identical requests when httpStatus differs", () => {
    const timestamp = "2026-09-20T10:02:00.000Z";
    const tokens = { prompt_tokens: 5, completion_tokens: 7 };
    insertRow({ timestamp, provider: "openai", model: "dup-status", status: "ok", httpStatus: 200, tokens });
    insertRow({ timestamp, provider: "openai", model: "dup-status", status: "error", httpStatus: 502, tokens });

    const rows = usageRepo.buildCompletedRecentRows(adapter, 100).filter((r) => r.model === "dup-status");
    expect(rows).toHaveLength(2);
  });

  it("collapses fully identical rows in the same minute", () => {
    const timestamp = "2026-09-20T10:03:00.000Z";
    const tokens = { prompt_tokens: 3, completion_tokens: 4 };
    insertRow({ timestamp, provider: "openai", model: "same-row", status: "ok", httpStatus: 200, tokens });
    insertRow({ timestamp, provider: "openai", model: "same-row", status: "ok", httpStatus: 200, tokens });

    const rows = usageRepo.buildCompletedRecentRows(adapter, 100).filter((r) => r.model === "same-row");
    expect(rows).toHaveLength(1);
  });

  it("returns rows newest-first and carries connectionId", () => {
    insertRow({ timestamp: "2026-09-20T10:04:00.000Z", provider: "openai", model: "with-conn", connectionId: "conn-123", status: "ok", httpStatus: 200, tokens: { prompt_tokens: 1, completion_tokens: 1 } });

    const rows = usageRepo.buildCompletedRecentRows(adapter, 100);
    const hit = rows.find((r) => r.model === "with-conn");
    expect(hit.connectionId).toBe("conn-123");
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i - 1].timestamp).getTime()).toBeGreaterThanOrEqual(new Date(rows[i].timestamp).getTime());
    }
  });
});

describe("recent requests account mapping (single data source)", () => {
  it("maps a completed connectionId to the connection name via getActiveRequests", async () => {
    const conn = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "My OpenAI Key", apiKey: "sk-test" });
    insertRow({ timestamp: new Date().toISOString(), provider: "openai", model: "mapped-model", connectionId: conn.id, status: "ok", httpStatus: 200, tokens: { prompt_tokens: 2, completion_tokens: 3 } });

    const { recentRequests } = await usageRepo.getActiveRequests();
    const hit = recentRequests.find((r) => r.model === "mapped-model");
    expect(hit).toBeDefined();
    expect(hit.account).toBe("My OpenAI Key");
  });

  it("returns completed history from the DB without any prior ring warm-up", async () => {
    // Simulates a refresh right after process start: no completed row was ever
    // pushed to an in-memory ring, yet history must still be present.
    insertRow({ timestamp: new Date().toISOString(), provider: "anthropic", model: "cold-start-model", status: "ok", httpStatus: 200, tokens: { prompt_tokens: 4, completion_tokens: 6 } });

    const { recentRequests } = await usageRepo.getActiveRequests();
    expect(recentRequests.some((r) => r.model === "cold-start-model")).toBe(true);
  });

  it("leaves account undefined for rows without a connectionId", async () => {
    insertRow({ timestamp: new Date().toISOString(), provider: "openai", model: "no-conn", status: "ok", httpStatus: 200, tokens: { prompt_tokens: 2, completion_tokens: 3 } });

    const { recentRequests } = await usageRepo.getActiveRequests();
    const hit = recentRequests.find((r) => r.model === "no-conn");
    expect(hit).toBeDefined();
    expect(hit.account).toBeUndefined();
  });

  it("getUsageStats exposes the same account-mapped rows as getActiveRequests", async () => {
    const stats = await usageRepo.getUsageStats("24h");
    const hit = stats.recentRequests.find((r) => r.model === "mapped-model");
    expect(hit).toBeDefined();
    expect(hit.account).toBe("My OpenAI Key");
  });
});
