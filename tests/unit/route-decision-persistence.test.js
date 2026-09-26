// T-3: `routeDecision` must survive persistence, including when the request body
// is large enough to be truncated.
//
// This is the failure mode the field's placement guards against. `truncateField`
// replaces an object wholesale with `{_truncated,_originalSize,_preview}` once it
// exceeds `maxJsonSize` (default 5 * 1024 chars). A routing decision nested inside
// `request` would therefore vanish silently on any large request — the row still
// saves, the field is just gone, and nothing errors. So `routeDecision` is stored
// top-level, next to the equally-untruncated `latency` / `tokens` objects.
//
// Flushing note: `saveRequestDetail` only pushes onto an in-memory buffer. It
// flushes when `batchSize` is reached (default 20) or after `flushIntervalMs`
// (default 5000), and `flushToDatabase` is not exported. This test sets
// `observabilityBatchSize: 1` so a single push flushes, then polls for the row
// rather than reaching for a test-only export hook in production code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { cleanupTempDb } from "../helpers/tempDb.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

const ROUTE_DECISION = {
  strategy: "round-robin",
  comboName: "combo/cheap",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  hit: 2,
};

function detail(id, overrides = {}) {
  return {
    id,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    timestamp: new Date().toISOString(),
    status: "success",
    latency: { ttft: 12, total: 40 },
    tokens: { prompt_tokens: 10, completion_tokens: 20 },
    routeDecision: ROUTE_DECISION,
    request: { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] },
    providerRequest: { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] },
    response: { content: "ok" },
    ...overrides,
  };
}

/** Poll until the row is visible, since the flush is fire-and-forget. */
async function waitForRow(id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { details } = await db.getRequestDetails({ pageSize: 200 });
    const hit = details.find((r) => r.id === id);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`row ${id} never flushed`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-route-decision-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  // Must be set before the first config read: requestDetailsRepo caches the
  // observability config for 5s.
  await db.updateSettings({ enableObservability2: true, observabilityBatchSize: 1 });
});

afterAll(async () => {
  await cleanupTempDb(tempDir);
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("routeDecision persistence", () => {
  it("persists the routing decision on the saved row", async () => {
    await db.saveRequestDetail(detail("rd-small"));
    const row = await waitForRow("rd-small");
    expect(row.routeDecision).toEqual(ROUTE_DECISION);
  });

  it("keeps routeDecision when the request body is truncated", async () => {
    // Comfortably past the 5 KiB default so truncateField() fires.
    const huge = "x".repeat(20000);
    await db.saveRequestDetail(
      detail("rd-huge", { request: { model: "m", blob: huge }, providerRequest: { model: "m", blob: huge } }),
    );

    const row = await waitForRow("rd-huge");
    // The body really was truncated...
    expect(row.request?._truncated).toBe(true);
    // ...and the decision survived anyway, because it is stored top-level.
    expect(row.routeDecision).toEqual(ROUTE_DECISION);
  });

  it("stores null rather than omitting the field when no decision was given", async () => {
    const noDecision = detail("rd-none");
    delete noDecision.routeDecision;
    await db.saveRequestDetail(noDecision);
    const row = await waitForRow("rd-none");
    expect(row.routeDecision).toBeNull();
  });

  it("does not leak routeDecision into the truncated request object", async () => {
    const huge = "y".repeat(20000);
    await db.saveRequestDetail(detail("rd-noleak", { request: { blob: huge } }));
    const row = await waitForRow("rd-noleak");
    expect(row.request).not.toHaveProperty("routeDecision");
  });
});
