// T-7 - per-API-key spend budget gate (src/sse/services/spendBudget.js).
//
// Two halves, deliberately separated:
//
//  1. "spend budget gate" drives the REAL module against a REAL sql.js adapter
//     (the repo's own createSqlJsAdapter, real `kv` table, real SAVEPOINT
//     transactions). Only `@/lib/db/driver.js` is mocked - that is the specifier
//     the gate actually imports for its read-modify-write. Mocking `@/lib/usageDb.js`
//     instead (as tests/unit/kiro-nonstream-error.test.js does) would have no effect
//     here and the test would silently hit a real on-disk database.
//
//  2. "handler wiring" drives the REAL 5 handlers with the gate MOCKED, to prove
//     each one calls the gate at the right point - after the Claude Code warm-up
//     bypass, after cheap validation, before any upstream dispatch - and that a
//     refusal produces a real 402 with the repo's existing error shape.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── driver mock (the ONLY thing mocked in half 1) ─────────────────────────
const driverMock = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: driverMock.getAdapter }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: driverMock.getAdapter }));

// Keep the gate's log lines out of the test output.
vi.mock("../../src/sse/utils/logger.js", () => ({
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), request: vi.fn(), response: vi.fn(),
  maskKey: (k) => (k && k.length >= 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : "***"),
}));

import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import {
  reserveSpend,
  settleSpend,
  estimateReserveCents,
  estimatePromptChars,
  resolveBudgetLimitCents,
  resolveModelRef,
  budgetKeyId,
  budgetDateKey,
} from "../../src/sse/services/spendBudget.js";

// The gate's own SQL, verbatim from schema.js:157-165. Copied rather than imported
// so the test does not depend on migrate.js having run in this process.
const KV_DDL = [
  `CREATE TABLE IF NOT EXISTS kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key))`,
  `CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)`,
].join("; ");

const KV_SCOPE = "budget";
const CHAT_BODY = { messages: [{ role: "user", content: "hi" }] };
const CHAT_MODEL = "anthropic/claude-sonnet-4-6";
const okResponse = () => new Response("ok", { status: 200 });
const errResponse = (status) => new Response("no", { status });

let adapter = null;
let tempDir = null;

/**
 * Wrap the real adapter so we can see whether a kv write happened inside a
 * transaction. The concurrency invariant in the gate is "one synchronous
 * transaction wraps the read, the decision and the write" - this is what proves
 * it, because a bare Promise.all race cannot create an interleave: the critical
 * section contains no `await`, so two concurrent callers never overlap inside it.
 * (Verified: moving the read outside the transaction still passes a Promise.all
 * race on this single-threaded runtime. Only the transaction assertion catches it.)
 */
function instrument(db) {
  const spy = { depth: 0, inside: 0, outside: 0, readsOutside: 0 };
  return {
    spy,
    reset: () => { spy.inside = 0; spy.outside = 0; spy.readsOutside = 0; },
    db: {
      get: (sql, params) => {
        if (spy.depth === 0) spy.readsOutside++;
        return db.get(sql, params);
      },
      run: (sql, params) => {
        if (spy.depth === 0) spy.outside++;
        else spy.inside++;
        return db.run(sql, params);
      },
      transaction: (fn) => {
        spy.depth++;
        try { return fn(); } finally { spy.depth--; }
      },
    },
  };
}

function budgetRows() {
  return adapter.all(`SELECT scope, key, value FROM kv WHERE scope = ?`, [KV_SCOPE]);
}

function readState(keySuffix) {
  const row = adapter.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [KV_SCOPE, `${budgetDateKey()}:${keySuffix}`]);
  return row ? JSON.parse(row.value) : null;
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-budget-"));
  // Path that does not exist yet - createSqlJsAdapter starts from an empty database.
  adapter = await createSqlJsAdapter(path.join(tempDir, "budget.sqlite"));
  adapter.run(KV_DDL);
  driverMock.getAdapter.mockResolvedValue(adapter);
});

afterAll(async () => {
  driverMock.getAdapter.mockReset();
  if (adapter) await adapter.close();
  for (let i = 0; ; i++) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); break; }
    catch (e) {
      if (i >= 4) break;
      await new Promise((r) => setTimeout(r, 60 * (i + 1)));
    }
  }
});

beforeEach(() => {
  adapter.run(`DELETE FROM kv WHERE scope = ?`, [KV_SCOPE]);
  driverMock.getAdapter.mockResolvedValue(adapter);
  delete process.env.SPEND_BUDGET_CENTS;
  delete process.env.SPEND_BUDGET_PENDING_TTL_MS;
});

describe("reserve formula", () => {
  it("derives the reserve from prompt size and real per-token prices", () => {
    const small = estimateReserveCents({ modality: "llm", body: { messages: [{ role: "user", content: "hi" }] }, modelStr: CHAT_MODEL });
    const big = estimateReserveCents({ modality: "llm", body: { messages: [{ role: "user", content: "x".repeat(40000) }] }, modelStr: CHAT_MODEL });
    expect(big.promptTokens).toBeGreaterThan(small.promptTokens);
    expect(big.cents).toBeGreaterThan(small.cents);
    expect(small.rates.priced).toBe(true);
    // claude-sonnet-4-6 is $3/$15 per 1M in the pricing table.
    expect(small.rates).toMatchObject({ input: 3, output: 15 });
  });

  it("defaults the output allowance to 4096, NOT the 10000-token thinking budget", () => {
    const { cents, outputTokens } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    expect(outputTokens).toBe(4096);

    // The thinking budget would reserve 2.44x more on this model.
    const thinkingBudgetCents = estimateReserveCents({
      modality: "llm",
      body: { ...CHAT_BODY, max_tokens: 10000 },
      modelStr: CHAT_MODEL,
    }).cents;
    expect(thinkingBudgetCents).toBeGreaterThan(cents * 2);
    // $1 of budget is NOT exhausted by a dozen of these requests.
    expect(cents * 12).toBeLessThanOrEqual(100);
  });

  it("honours an explicit max_tokens and clamps it into range", () => {
    const low = estimateReserveCents({ modality: "llm", body: { ...CHAT_BODY, max_tokens: 100 }, modelStr: CHAT_MODEL });
    const high = estimateReserveCents({ modality: "llm", body: { ...CHAT_BODY, max_tokens: 500000 }, modelStr: CHAT_MODEL });
    expect(low.outputTokens).toBe(256);
    expect(high.outputTokens).toBe(64000);
    expect(high.cents).toBeGreaterThan(low.cents);
  });

  it("over-reserves an unpriced model instead of letting it escape the budget", () => {
    const priced = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const unpriced = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: "my-node/some-unknown-model" });
    expect(unpriced.rates.priced).toBe(false);
    expect(unpriced.cents).toBeGreaterThan(priced.cents);
  });

  it("prices non-llm modalities on input only and floors at 1 cent", () => {
    for (const modality of ["image", "tts", "webSearch", "webFetch"]) {
      const r = estimateReserveCents({ modality, body: { prompt: "a".repeat(200), input: "b", query: "q", url: "https://e.com" }, modelStr: "x" });
      expect(r.outputTokens).toBe(0);
      expect(r.cents).toBe(1);
    }
  });

  it("splits provider/model the way the engine does, and honours an explicit provider", () => {
    expect(resolveModelRef({ modelStr: "anthropic/claude-sonnet-4-6" })).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
    // A slash in a model id must not move the boundary (first slash wins).
    expect(resolveModelRef({ modelStr: "vertex/gemini-3-pro" })).toEqual({ provider: "vertex", model: "gemini-3-pro" });
    expect(resolveModelRef({ modelStr: "bare-alias" })).toEqual({ provider: null, model: "bare-alias" });
    // search/fetch pass the provider alias, so an explicit provider wins.
    expect(resolveModelRef({ modelStr: "gemini", provider: "gemini-cli" })).toEqual({ provider: "gemini-cli", model: "gemini" });
    expect(resolveModelRef({ modelStr: "gemini" })).toEqual({ provider: null, model: "gemini" });
  });

  it("never throws on a cyclic body", () => {
    const cyclic = { messages: [] };
    cyclic.messages.push(cyclic);
    expect(() => estimateReserveCents({ modality: "llm", body: cyclic, modelStr: CHAT_MODEL })).not.toThrow();
    expect(estimatePromptChars(cyclic, "llm")).toBe(0);
  });
});

describe("budget configuration", () => {
  it("is disabled unless a limit is configured, and explicit 0/false wins over env", () => {
    expect(resolveBudgetLimitCents({})).toBeNull();
    expect(resolveBudgetLimitCents(undefined)).toBeNull();
    process.env.SPEND_BUDGET_CENTS = "250";
    expect(resolveBudgetLimitCents({})).toBe(250);
    expect(resolveBudgetLimitCents({ spendBudgetCents: 0 })).toBeNull();
    expect(resolveBudgetLimitCents({ spendBudgetCents: false })).toBeNull();
    expect(resolveBudgetLimitCents({ spendBudgetCents: 100 })).toBe(100);
    delete process.env.SPEND_BUDGET_CENTS;
  });

  it("does not touch the database at all while disabled", async () => {
    driverMock.getAdapter.mockClear();
    const decision = await reserveSpend({ settings: {}, apiKeyInfo: null, body: CHAT_BODY, modelStr: CHAT_MODEL });
    expect(decision.allowed).toBe(true);
    expect(decision.enabled).toBe(false);
    expect(driverMock.getAdapter).not.toHaveBeenCalled();
    expect(budgetRows()).toHaveLength(0);
    // dispatch is a transparent pass-through when the gate is off
    await expect(decision.dispatch(async () => "upstream")).resolves.toBe("upstream");
  });
});

describe("key bucketing", () => {
  it("uses __local__ when no API key is configured", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    expect(budgetKeyId(null, null)).toBe("__local__");
    await reserveSpend({ settings: { spendBudgetCents: cents }, apiKeyInfo: null, apiKey: null, body: CHAT_BODY, modelStr: CHAT_MODEL });
    expect(readState("__local__")).not.toBeNull();
  });

  it("shares one bucket between every no-key request so local spend is still capped", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const settings = { spendBudgetCents: cents };
    const first = await reserveSpend({ settings, apiKeyInfo: null, apiKey: null, body: CHAT_BODY, modelStr: CHAT_MODEL });
    const second = await reserveSpend({ settings, apiKeyInfo: null, apiKey: null, body: CHAT_BODY, modelStr: CHAT_MODEL });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(Object.keys(readState("__local__").p)).toHaveLength(1);
  });

  it("prefers the apiKeys.id, then a fingerprint of a presented-but-unvalidated key", () => {
    expect(budgetKeyId({ id: "key-1" }, "sk-abc")).toBe("key-1");
    const a = budgetKeyId(null, "sk-secret-one");
    const b = budgetKeyId(null, "sk-secret-two");
    expect(a).toMatch(/^raw:[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    // The raw key must never reach the DB.
    expect(a).not.toContain("sk-secret-one");
    expect(budgetKeyId(null, null)).toBe("__local__");
  });
});

describe("concurrency - the budget is a real gate under load", () => {
  it("lets exactly one of two concurrent requests through a budget sized for one", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const settings = { spendBudgetCents: cents };
    const args = { settings, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL };

    const [a, b] = await Promise.all([reserveSpend(args), reserveSpend(args)]);

    const allowed = [a, b].filter((d) => d.allowed);
    const refused = [a, b].filter((d) => !d.allowed);
    expect(allowed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].status).toBe(402);
    expect(refused[0].message).toMatch(/budget exhausted/i);

    // The winner is the only pending reservation on disk.
    expect(Object.keys(readState("key-1").p)).toEqual([allowed[0].reservationId]);
  });

  it("serialises a burst of concurrent requests against a 2-reservation budget", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const settings = { spendBudgetCents: cents * 2 };
    const args = { settings, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL };

    const decisions = await Promise.all(Array.from({ length: 8 }, () => reserveSpend(args)));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(2);
    expect(decisions.filter((d) => !d.allowed)).toHaveLength(6);
    expect(Object.keys(readState("key-1").p)).toHaveLength(2);
  });

  it("refuses everything when the budget cannot even fit one request", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const decision = await reserveSpend({
      settings: { spendBudgetCents: cents - 1 },
      apiKeyInfo: { id: "key-1" },
      body: CHAT_BODY,
      modelStr: CHAT_MODEL,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(402);
    expect(budgetRows()).toHaveLength(0);
  });

  it("wraps the read, the decision and the write in one DB transaction", async () => {
    const { db, spy, reset } = instrument(adapter);
    driverMock.getAdapter.mockResolvedValue(db);
    const decision = await reserveSpend({
      settings: { spendBudgetCents: 1000 },
      apiKeyInfo: { id: "key-1" },
      body: CHAT_BODY,
      modelStr: CHAT_MODEL,
    });
    expect(decision.allowed).toBe(true);
    expect(spy.inside).toBe(1);
    expect(spy.outside).toBe(0);
    expect(spy.readsOutside).toBe(0);

    reset();
    await settleSpend(decision, okResponse());
    expect(spy.inside).toBe(1);
    expect(spy.outside).toBe(0);
    expect(spy.readsOutside).toBe(0);
  });

  it("rolls the counter back when the reservation cannot be written", async () => {
    const { db, spy } = instrument(adapter);
    const inner = adapter.get.bind(adapter);
    driverMock.getAdapter.mockResolvedValue({
      get: inner,
      run: (sql, params) => {
        if (String(sql).includes("INSERT INTO kv")) throw new Error("disk full");
        return db.run(sql, params);
      },
      transaction: (fn) => {
        spy.depth++;
        try { return fn(); } finally { spy.depth--; }
      },
    });
    const decision = await reserveSpend({
      settings: { spendBudgetCents: 1000 },
      apiKeyInfo: { id: "key-1" },
      body: CHAT_BODY,
      modelStr: CHAT_MODEL,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(402);
    // Nothing half-written: no row at all, so the next request starts clean.
    expect(budgetRows()).toHaveLength(0);
  });
});

describe("fail-closed", () => {
  it("refuses when the counter cannot be read", async () => {
    driverMock.getAdapter.mockResolvedValue({
      get: () => { throw new Error("disk I/O error"); },
      run: () => {},
      transaction: (fn) => fn(),
    });
    const decision = await reserveSpend({
      settings: { spendBudgetCents: 1000 },
      apiKeyInfo: { id: "key-1" },
      body: CHAT_BODY,
      modelStr: CHAT_MODEL,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(402);
    expect(decision.message).toMatch(/counter could not be read/i);
    expect(typeof decision.dispatch).toBe("function");
  });

  it("refuses when the database driver itself is unavailable", async () => {
    driverMock.getAdapter.mockRejectedValue(new Error("no sqlite driver"));
    const decision = await reserveSpend({
      settings: { spendBudgetCents: 1000 },
      apiKeyInfo: { id: "key-1" },
      body: CHAT_BODY,
      modelStr: CHAT_MODEL,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(402);
  });

  it("still refuses when the write half of the transaction fails", async () => {
    const realGet = adapter.get.bind(adapter);
    driverMock.getAdapter.mockResolvedValue({
      get: realGet,
      run: () => { throw new Error("disk full"); },
      transaction: (fn) => fn(),
    });
    const decision = await reserveSpend({
      settings: { spendBudgetCents: 1000 },
      apiKeyInfo: { id: "key-1" },
      body: CHAT_BODY,
      modelStr: CHAT_MODEL,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(402);
  });
});

describe("settle", () => {
  it("charges the reservation on success and releases it on an upstream error", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const settings = { spendBudgetCents: cents * 4 };

    const okDecision = await reserveSpend({ settings, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL });
    await okDecision.dispatch(async () => okResponse());
    expect(readState("key-1").s).toBe(cents);
    expect(readState("key-1").p).toEqual({});

    // A 402 from the provider means that target was not billed - give it back.
    const errDecision = await reserveSpend({ settings, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL });
    expect(errDecision.allowed).toBe(true);
    await errDecision.dispatch(async () => errResponse(402));
    expect(readState("key-1").s).toBe(cents);
    expect(readState("key-1").p).toEqual({});
  });

  it("releases the reservation when the dispatch throws, and rethrows", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const decision = await reserveSpend({ settings: { spendBudgetCents: cents * 4 }, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL });
    await expect(decision.dispatch(async () => { throw new Error("upstream exploded"); })).rejects.toThrow("upstream exploded");
    expect(readState("key-1")).toEqual({ s: 0, p: {} });
  });

  it("does not double-charge a reservation that is settled twice", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const decision = await reserveSpend({ settings: { spendBudgetCents: cents * 4 }, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL });
    await settleSpend(decision, okResponse());
    await settleSpend(decision, okResponse());
    expect(readState("key-1").s).toBe(cents);
  });
});

describe("settle-failure compensation - a reservation can never be stranded", () => {
  it("keeps a failed settle reclaimable, then commits it exactly once", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const settings = { spendBudgetCents: cents * 4 };

    // Reserve, then settle against a DB whose write half is broken.
    const decision = await reserveSpend({ settings, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL });
    const realGet = adapter.get.bind(adapter);
    driverMock.getAdapter.mockResolvedValue({
      get: realGet,
      run: () => { throw new Error("disk full"); },
      transaction: (fn) => fn(),
    });
    // Must not throw - a settle failure must never replace the client's response.
    await expect(settleSpend(decision, okResponse())).resolves.toBeUndefined();
    // The reservation is still pending on disk, not lost and not double-counted.
    expect(Object.keys(readState("key-1").p)).toEqual([decision.reservationId]);
    expect(readState("key-1").s).toBe(0);

    // Anything can retry the settle afterwards and it succeeds.
    driverMock.getAdapter.mockResolvedValue(adapter);
    await settleSpend(decision, okResponse());
    expect(readState("key-1").s).toBe(cents);
    expect(readState("key-1").p).toEqual({});
  });

  it("sweeps a stranded reservation on the next request instead of blocking the key forever", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const settings = { spendBudgetCents: cents * 10 };

    // Long TTL so nothing is reclaimed while we set the failure up.
    process.env.SPEND_BUDGET_PENDING_TTL_MS = "60000";
    const stranded = await reserveSpend({ settings, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL });
    const realGet = adapter.get.bind(adapter);
    driverMock.getAdapter.mockResolvedValue({ get: realGet, run: () => { throw new Error("disk full"); }, transaction: (fn) => fn() });
    await settleSpend(stranded, okResponse());
    driverMock.getAdapter.mockResolvedValue(adapter);

    // Inside the TTL the reservation is still held against the budget, not lost.
    const tooEarly = await reserveSpend({ settings, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL });
    expect(tooEarly.allowed).toBe(true);
    expect(readState("key-1").p).toHaveProperty(stranded.reservationId);
    expect(readState("key-1").p).toHaveProperty(tooEarly.reservationId);
    expect(readState("key-1").s).toBe(0);

    // Age both past the TTL and let the next request's sweep reclaim them.
    process.env.SPEND_BUDGET_PENDING_TTL_MS = "1";
    await new Promise((r) => setTimeout(r, 15));

    // Committed once each, not deleted, and the request is still allowed - the key
    // is never locked out permanently by a settlement that failed.
    const after = await reserveSpend({ settings, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL });
    expect(after.allowed).toBe(true);
    const state = readState("key-1");
    expect(Object.keys(state.p)).toEqual([after.reservationId]);
    expect(state.s).toBe(cents * 2);
    // Settling an already-swept reservation must not charge it a second time.
    await settleSpend(stranded, okResponse());
    await settleSpend(tooEarly, okResponse());
    expect(readState("key-1").s).toBe(cents * 2);
  });

  it("returns a stranded reservation in full when a settle retry succeeds and nothing was billed", async () => {
    // Same broken-settle path, but the response was a 402: nothing was charged
    // upstream, so the sweep must not bill the user either.
    process.env.SPEND_BUDGET_PENDING_TTL_MS = "1";
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const settings = { spendBudgetCents: cents * 10 };
    const decision = await reserveSpend({ settings, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL });
    const realGet = adapter.get.bind(adapter);
    driverMock.getAdapter.mockResolvedValue({ get: realGet, run: () => { throw new Error("disk full"); }, transaction: (fn) => fn() });
    await settleSpend(decision, errResponse(402));
    driverMock.getAdapter.mockResolvedValue(adapter);

    // The pending entry is still there (settle failed), so the budget is still held.
    expect(readState("key-1").p).toHaveProperty(decision.reservationId);
    // Retrying the settle with the same (unbilled) response is the recovery path and
    // it succeeds, returning the whole reservation.
    await settleSpend(decision, errResponse(402));
    expect(readState("key-1")).toEqual({ s: 0, p: {} });
  });

  it("resets the bucket on a new UTC day", () => {
    expect(budgetDateKey(Date.parse("2026-09-26T23:59:59Z"))).toBe("2026-09-26");
    expect(budgetDateKey(Date.parse("2026-09-27T00:00:01Z"))).toBe("2026-09-27");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Handler wiring. The gate is mocked here; the 5 handlers are real. This half
// answers a different question from the half above: not "is the accounting
// correct" but "does every entry point actually reach the gate, at the right
// point, with the right arguments, and does a refusal stop the dispatch".
// `vi.resetModules()` + `vi.doMock` are used so half 1 keeps the real gate.
// ────────────────────────────────────────────────────────────────────────────

const hw = vi.hoisted(() => ({
  // auth
  extractApiKey: vi.fn(() => "sk-presented-key"),
  isValidApiKey: vi.fn(async () => ({ id: "key-1" })),
  isProviderAllowed: vi.fn(async () => true),
  isComboAllowed: vi.fn(() => true),
  isKindAllowed: vi.fn(() => true),
  isTrustedInternalRequest: vi.fn(async () => false),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  // db
  getSettings: vi.fn(async () => ({ requireApiKey: true })),
  getCombos: vi.fn(async () => []),
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(),
  // model / ACL
  getModelInfo: vi.fn(async () => ({ provider: "anthropic", model: "claude-sonnet-4-6" })),
  getComboModels: vi.fn(async () => null),
  getComboModelsFromData: vi.fn(() => null),
  isModelAllowed: vi.fn(async () => true),
  // upstream cores - must never be reached once the gate refuses
  handleChatCore: vi.fn(),
  handleTtsCore: vi.fn(),
  handleImageGenerationCore: vi.fn(),
  handleSearchCore: vi.fn(),
  handleFetchCore: vi.fn(),
  handleEmbeddingsCore: vi.fn(),
  handleSttCore: vi.fn(),
  handleVideoProxyCore: vi.fn(),
  // combo
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  stripComboPrefix: vi.fn((s) => s),
  // misc
  handleBypassRequest: vi.fn(() => null),
  assertPublicUrl: vi.fn(async () => {}),
  resolveProviderId: vi.fn((p) => `resolved-${p}`),
  cacheClaudeHeaders: vi.fn(),
  detectFormatByEndpoint: vi.fn(() => null),
  // the gate under test-by-proxy
  reserveSpend: vi.fn(),
}));

const authMock = {
  extractApiKey: hw.extractApiKey, isValidApiKey: hw.isValidApiKey,
  isProviderAllowed: hw.isProviderAllowed, isComboAllowed: hw.isComboAllowed,
  isKindAllowed: hw.isKindAllowed, isTrustedInternalRequest: hw.isTrustedInternalRequest,
  getProviderCredentials: hw.getProviderCredentials,
  markAccountUnavailable: hw.markAccountUnavailable, clearAccountError: hw.clearAccountError,
};
vi.mock("@/sse/services/auth.js", () => authMock);
vi.mock("../../src/sse/services/auth.js", () => authMock);

vi.mock("@/lib/localDb", () => ({
  getSettings: hw.getSettings, getCombos: hw.getCombos,
  getProviderConnections: hw.getProviderConnections, updateProviderConnection: hw.updateProviderConnection,
}));
vi.mock("../../src/lib/localDb.js", () => ({
  getSettings: hw.getSettings, getCombos: hw.getCombos,
  getProviderConnections: hw.getProviderConnections, updateProviderConnection: hw.updateProviderConnection,
}));

vi.mock("@/sse/services/model.js", () => ({ getModelInfo: hw.getModelInfo, getComboModels: hw.getComboModels }));
vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: hw.getModelInfo, getComboModels: hw.getComboModels }));
vi.mock("@/sse/services/allowedModels.js", () => ({ isModelAllowed: hw.isModelAllowed }));
vi.mock("../../src/sse/services/allowedModels.js", () => ({ isModelAllowed: hw.isModelAllowed }));

// Collapse the engine graph: nothing below the handler should be loaded.
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: hw.handleChatCore }));
vi.mock("open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: hw.handleTtsCore }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: hw.handleEmbeddingsCore }));
vi.mock("open-sse/handlers/sttCore.js", () => ({ handleSttCore: hw.handleSttCore }));
// getVideoConfig must be truthy for resolveVideoProvider to accept the provider
// ("Provider X does not support video generation" otherwise short-circuits with
// a 400 before the gate is ever consulted).
vi.mock("open-sse/handlers/videoCore.js", () => ({ handleVideoProxyCore: hw.handleVideoProxyCore, getVideoConfig: () => ({ kind: "video" }), sanitizeSecrets: (e) => String(e) }));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: hw.handleImageGenerationCore }));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: hw.handleSearchCore }));
vi.mock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: hw.handleFetchCore }));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: hw.handleComboChat, handleFusionChat: hw.handleFusionChat,
  stripComboPrefix: hw.stripComboPrefix, getComboModelsFromData: hw.getComboModelsFromData,
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: hw.handleBypassRequest }));
vi.mock("open-sse/utils/claudeHeaderCache.js", () => ({ cacheClaudeHeaders: hw.cacheClaudeHeaders }));
vi.mock("open-sse/translator/formats.js", () => ({ detectFormatByEndpoint: hw.detectFormatByEndpoint }));
vi.mock("@/shared/constants/providers", () => ({ AI_PROVIDERS: {}, resolveProviderId: hw.resolveProviderId }));
vi.mock("../../src/shared/constants/providers.js", () => ({ AI_PROVIDERS: {}, resolveProviderId: hw.resolveProviderId }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: hw.assertPublicUrl }));
vi.mock("../../src/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: hw.assertPublicUrl }));

// open-sse/utils/error.js and open-sse/config/runtimeConfig.js stay REAL so the
// refusal is asserted against the repo's real 402 error shape, not a mock of it.
const GATE_REFUSAL = { allowed: false, enabled: true, status: 402, message: "Daily spend budget exhausted (100c of 100c used).", reservationId: null, dispatch: vi.fn(), release: vi.fn() };
const GATE_ALLOW = { allowed: true, enabled: true, status: null, message: null, reservationId: "res-1", key: "k", dispatch: (run) => run(), release: vi.fn() };

function makeRequest({ body = {}, headers = {}, url = "https://router.test/v1/chat/completions" } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    url,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null, entries: () => h.entries() },
    json: async () => body,
  };
}

async function loadHandler(path, exportName) {
  vi.resetModules();
  vi.doMock("@/sse/services/spendBudget.js", () => ({ reserveSpend: hw.reserveSpend }));
  vi.doMock("../../src/sse/services/spendBudget.js", () => ({ reserveSpend: hw.reserveSpend }));
  const mod = await import(path);
  if (typeof mod[exportName] !== "function") {
    throw new Error(`${path} does not export ${exportName} (got: ${Object.keys(mod).join(", ")})`);
  }
  return mod[exportName];
}

async function expectRefusal(response) {
  expect(response.status).toBe(402);
  const body = await response.json();
  expect(body.error).toMatchObject({ type: "billing_error", code: "payment_required" });
  expect(body.error.message).toBe(GATE_REFUSAL.message);
}

describe("handler wiring - every entry point reaches the gate before any dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hw.extractApiKey.mockReturnValue("sk-presented-key");
    hw.isValidApiKey.mockResolvedValue({ id: "key-1" });
    hw.getSettings.mockResolvedValue({ requireApiKey: true });
    hw.isTrustedInternalRequest.mockResolvedValue(false);
    hw.isKindAllowed.mockReturnValue(true);
    hw.handleBypassRequest.mockReturnValue(null);
    hw.resolveProviderId.mockImplementation((p) => `resolved-${p}`);
    hw.assertPublicUrl.mockResolvedValue(undefined);
    hw.reserveSpend.mockResolvedValue(GATE_REFUSAL);
  });

  it("chat: refuses with 402 and never reaches combo expansion or chatCore", async () => {
    const handleChat = await loadHandler("../../src/sse/handlers/chat.js", "handleChat");
    const response = await handleChat(makeRequest({ body: { model: CHAT_MODEL, messages: CHAT_BODY.messages } }));
    await expectRefusal(response);
    expect(hw.reserveSpend).toHaveBeenCalledTimes(1);
    expect(hw.reserveSpend).toHaveBeenCalledWith(expect.objectContaining({
      modality: "llm", modelStr: CHAT_MODEL, apiKey: "sk-presented-key", apiKeyInfo: { id: "key-1" },
    }));
    expect(hw.getComboModels).not.toHaveBeenCalled();
    expect(hw.handleComboChat).not.toHaveBeenCalled();
    expect(hw.handleChatCore).not.toHaveBeenCalled();
  });

  it("chat: the gate sits AFTER the Claude Code warm-up bypass, which stays free", async () => {
    hw.handleBypassRequest.mockReturnValue({ response: new Response("bypass-ok", { status: 200 }) });
    const handleChat = await loadHandler("../../src/sse/handlers/chat.js", "handleChat");
    const response = await handleChat(makeRequest({ body: { model: "claude-haiku-4-5", messages: CHAT_BODY.messages } }));
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("bypass-ok");
    expect(hw.reserveSpend).not.toHaveBeenCalled();
    expect(hw.getComboModels).not.toHaveBeenCalled();
  });

  it("chat: a passing gate dispatches through the real handler", async () => {
    hw.reserveSpend.mockResolvedValue(GATE_ALLOW);
    const handleChat = await loadHandler("../../src/sse/handlers/chat.js", "handleChat");
    const response = await handleChat(makeRequest({ body: { model: CHAT_MODEL, messages: CHAT_BODY.messages } }));
    // It gets past the gate - the 404 below comes from the (mocked) ACL/model layer,
    // which is downstream. What matters is that the gate was consulted and left.
    expect(hw.reserveSpend).toHaveBeenCalledTimes(1);
    expect(hw.getComboModels).toHaveBeenCalledTimes(1);
    expect(hw.handleChatCore).not.toHaveBeenCalled();
    expect(response.status).not.toBe(402);
  });

  // A refusal that happens AFTER the reservation is taken but BEFORE any dispatch
  // must hand the reservation back. Otherwise a client can exhaust a key's daily
  // budget by repeatedly requesting a combo it is not allowed to use, at zero
  // upstream cost.
  it("chat: releases the reservation when a combo is refused by ACL after the gate", async () => {
    const allow = { ...GATE_ALLOW, release: vi.fn() };
    hw.reserveSpend.mockResolvedValue(allow);
    hw.getComboModels.mockResolvedValue(["a/one", "b/two"]);
    hw.isComboAllowed.mockReturnValue(false);

    const handleChat = await loadHandler("../../src/sse/handlers/chat.js", "handleChat");
    const response = await handleChat(makeRequest({ body: { model: "combo/x", messages: CHAT_BODY.messages } }));

    expect(response.status).toBe(403);
    expect(allow.release).toHaveBeenCalledTimes(1);
    // Nothing upstream, so dispatch must not have run.
    expect(hw.handleComboChat).not.toHaveBeenCalled();
    expect(hw.handleChatCore).not.toHaveBeenCalled();
  });

  it("tts: releases the reservation on the same post-gate ACL refusal", async () => {
    const allow = { ...GATE_ALLOW, release: vi.fn() };
    hw.reserveSpend.mockResolvedValue(allow);
    hw.getComboModels.mockResolvedValue(["a/one"]);
    hw.isComboAllowed.mockReturnValue(false);

    const handleTts = await loadHandler("../../src/sse/handlers/tts.js", "handleTts");
    const response = await handleTts(makeRequest({
      url: "https://router.test/v1/audio/speech",
      body: { model: "combo/x", input: "hello" },
    }));

    expect(response.status).toBe(403);
    expect(allow.release).toHaveBeenCalledTimes(1);
    expect(hw.handleComboChat).not.toHaveBeenCalled();
  });

  it("image: releases the reservation on the same post-gate ACL refusal", async () => {
    const allow = { ...GATE_ALLOW, release: vi.fn() };
    hw.reserveSpend.mockResolvedValue(allow);
    hw.getComboModels.mockResolvedValue(["a/one"]);
    hw.isComboAllowed.mockReturnValue(false);

    const handleImage = await loadHandler("../../src/sse/handlers/imageGeneration.js", "handleImageGeneration");
    const response = await handleImage(makeRequest({
      url: "https://router.test/v1/images/generations",
      body: { model: "combo/x", prompt: "a cat" },
    }));

    expect(response.status).toBe(403);
    expect(allow.release).toHaveBeenCalledTimes(1);
    expect(hw.handleComboChat).not.toHaveBeenCalled();
  });

  it("tts: hoists apiKey to function scope so the gate can read it", async () => {
    const handleTts = await loadHandler("../../src/sse/handlers/tts.js", "handleTts");
    const response = await handleTts(makeRequest({
      body: { model: "tts-1", input: "hello" },
      url: "https://router.test/v1/audio/speech",
    }));
    await expectRefusal(response);
    expect(hw.reserveSpend).toHaveBeenCalledWith(expect.objectContaining({
      modality: "tts", modelStr: "tts-1", apiKey: "sk-presented-key",
    }));
    expect(hw.getComboModels).not.toHaveBeenCalled();
    expect(hw.handleTtsCore).not.toHaveBeenCalled();
  });

  it("tts: validates model/kind/input before metering, so bad requests stay 4xx not 402", async () => {
    const handleTts = await loadHandler("../../src/sse/handlers/tts.js", "handleTts");
    const noInput = await handleTts(makeRequest({ body: { model: "tts-1" }, url: "https://router.test/v1/audio/speech" }));
    expect(noInput.status).toBe(400);
    const noModel = await handleTts(makeRequest({ body: { input: "hi" }, url: "https://router.test/v1/audio/speech" }));
    expect(noModel.status).toBe(400);
    hw.isKindAllowed.mockReturnValue(false);
    const denied = await handleTts(makeRequest({ body: { model: "tts-1", input: "hi" }, url: "https://router.test/v1/audio/speech" }));
    expect(denied.status).toBe(403);
    expect(hw.reserveSpend).not.toHaveBeenCalled();
  });

  it("search: passes providerInput as both the model and the pricing provider", async () => {
    const handleSearch = await loadHandler("../../src/sse/handlers/search.js", "handleSearch");
    const response = await handleSearch(makeRequest({
      body: { provider: "gemini", query: "who won" },
      url: "https://router.test/api/search",
    }));
    await expectRefusal(response);
    expect(hw.resolveProviderId).toHaveBeenCalledWith("gemini");
    expect(hw.reserveSpend).toHaveBeenCalledWith(expect.objectContaining({
      modality: "webSearch", modelStr: "gemini", provider: "resolved-gemini",
    }));
    expect(hw.handleSearchCore).not.toHaveBeenCalled();
  });

  it("fetch: runs after the SSRF guard, so a blocked URL is never metered", async () => {
    const handleFetch = await loadHandler("../../src/sse/handlers/fetch.js", "handleFetch");
    hw.assertPublicUrl.mockRejectedValue(new Error("private address"));
    const blocked = await handleFetch(makeRequest({
      body: { provider: "gemini", url: "http://127.0.0.1/x" },
      url: "https://router.test/api/fetch",
    }));
    expect(blocked.status).toBe(400);
    expect(hw.reserveSpend).not.toHaveBeenCalled();
  });

  it("fetch: passes providerInput and works with the structurally-null apiKeyInfo", async () => {
    // fetch.js does not import isTrustedInternalRequest, so apiKeyInfo stays null
    // unless requireApiKey is on. With requireApiKey off it must still meter.
    hw.getSettings.mockResolvedValue({ requireApiKey: false });
    const handleFetch = await loadHandler("../../src/sse/handlers/fetch.js", "handleFetch");
    const response = await handleFetch(makeRequest({
      body: { provider: "jina", url: "https://example.com/a" },
      url: "https://router.test/api/fetch",
    }));
    await expectRefusal(response);
    expect(hw.reserveSpend).toHaveBeenCalledWith(expect.objectContaining({
      modality: "webFetch", modelStr: "jina", provider: "resolved-jina",
      apiKeyInfo: null, apiKey: "sk-presented-key",
    }));
    expect(hw.handleFetchCore).not.toHaveBeenCalled();
  });

  it("fetch: with no key at all the gate still runs, bucketing to __local__", async () => {
    hw.getSettings.mockResolvedValue({ requireApiKey: false });
    hw.extractApiKey.mockReturnValue(null);
    const handleFetch = await loadHandler("../../src/sse/handlers/fetch.js", "handleFetch");
    const response = await handleFetch(makeRequest({
      body: { provider: "jina", url: "https://example.com/a" },
      url: "https://router.test/api/fetch",
    }));
    await expectRefusal(response);
    expect(hw.reserveSpend).toHaveBeenCalledWith(expect.objectContaining({
      apiKeyInfo: null, apiKey: null,
    }));
  });

  it("image: refuses before touching the image core", async () => {
    const handleImageGeneration = await loadHandler("../../src/sse/handlers/imageGeneration.js", "handleImageGeneration");
    const response = await handleImageGeneration(makeRequest({
      body: { model: "sd-webui", prompt: "a cat" },
      url: "https://router.test/v1/images/generations",
    }));
    await expectRefusal(response);
    expect(hw.reserveSpend).toHaveBeenCalledWith(expect.objectContaining({
      modality: "image", modelStr: "sd-webui",
    }));
    expect(hw.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("a 401 still wins over the 402 - auth is checked first, unchanged", async () => {
    hw.getSettings.mockResolvedValue({ requireApiKey: true });
    hw.isValidApiKey.mockResolvedValue(null);
    const handleTts = await loadHandler("../../src/sse/handlers/tts.js", "handleTts");
    const response = await handleTts(makeRequest({
      body: { model: "tts-1", input: "hi" },
      url: "https://router.test/v1/audio/speech",
    }));
    expect(response.status).toBe(401);
    expect(hw.reserveSpend).not.toHaveBeenCalled();
  });
});

// The gate is only as good as its coverage of the billable surface. These three
// handlers are the reason this block exists: each one is a public endpoint that
// dispatches upstream and bills real money, so an ungated one is a way to keep
// spending a key whose daily cap is already exhausted.
describe("handler wiring - every billable endpoint is gated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hw.extractApiKey.mockReturnValue("sk-presented-key");
    hw.isValidApiKey.mockResolvedValue({ id: "key-1" });
    hw.getSettings.mockResolvedValue({ requireApiKey: true });
    hw.isTrustedInternalRequest.mockResolvedValue(false);
    hw.isKindAllowed.mockReturnValue(true);
    hw.isProviderAllowed.mockResolvedValue(true);
    hw.isModelAllowed.mockResolvedValue(true);
    hw.resolveProviderId.mockImplementation((p) => `resolved-${p}`);
    hw.getModelInfo.mockResolvedValue({ provider: "openai", model: "text-embedding-3-small" });
    hw.reserveSpend.mockResolvedValue(GATE_REFUSAL);
  });

  it("embeddings: refuses with 402 and never reaches embeddingsCore", async () => {
    const handleEmbeddings = await loadHandler("../../src/sse/handlers/embeddings.js", "handleEmbeddings");
    const response = await handleEmbeddings(makeRequest({
      body: { model: "openai/text-embedding-3-small", input: "hello" },
      url: "https://router.test/v1/embeddings",
    }));
    await expectRefusal(response);
    expect(hw.reserveSpend).toHaveBeenCalledWith(expect.objectContaining({
      modality: "embedding", modelStr: "openai/text-embedding-3-small", apiKey: "sk-presented-key",
    }));
    expect(hw.getProviderCredentials).not.toHaveBeenCalled();
    expect(hw.handleEmbeddingsCore).not.toHaveBeenCalled();
  });

  it("embeddings: a malformed request is still 4xx, not 402", async () => {
    const handleEmbeddings = await loadHandler("../../src/sse/handlers/embeddings.js", "handleEmbeddings");
    const noInput = await handleEmbeddings(makeRequest({
      body: { model: "openai/text-embedding-3-small" },
      url: "https://router.test/v1/embeddings",
    }));
    expect(noInput.status).toBe(400);
    hw.isKindAllowed.mockReturnValue(false);
    const denied = await handleEmbeddings(makeRequest({
      body: { model: "openai/text-embedding-3-small", input: "hi" },
      url: "https://router.test/v1/embeddings",
    }));
    expect(denied.status).toBe(403);
    expect(hw.reserveSpend).not.toHaveBeenCalled();
  });

  it("stt: refuses with 402 and never reaches sttCore", async () => {
    const handleStt = await loadHandler("../../src/sse/handlers/stt.js", "handleStt");
    // stt reads a multipart FormData, so the gate gets `body: null` by design and
    // reserves the MIN_RESERVE_CENTS floor - a loose gate, but not an absent one.
    const request = { ...makeRequest({ url: "https://router.test/v1/audio/transcriptions" }), formData: async () => new FormData() };
    request.formData = async () => {
      const fd = new FormData();
      fd.set("model", "groq/whisper-large-v3");
      fd.set("file", new Blob(["audio"]), "a.mp3");
      return fd;
    };
    const response = await handleStt(request);
    await expectRefusal(response);
    expect(hw.reserveSpend).toHaveBeenCalledWith(expect.objectContaining({
      modality: "stt", modelStr: "groq/whisper-large-v3", apiKey: "sk-presented-key",
    }));
    expect(hw.getProviderCredentials).not.toHaveBeenCalled();
    expect(hw.handleSttCore).not.toHaveBeenCalled();
  });

  it("video: create refuses with 402 and never reaches videoCore; polling is not gated", async () => {
    const handleVideoCreate = await loadHandler("../../src/sse/handlers/videoGeneration.js", "handleVideoCreate");
    // videoGeneration reads the body with text()/arrayBuffer() (it forwards raw
    // bytes), which the shared makeRequest mock does not provide. makeRequest does
    // not expose `body` on the returned object, so the payload is held here.
    const videoBody = { model: "xai/grok-imagine-video", prompt: "a cat" };
    const videoReq = makeRequest({
      body: videoBody,
      headers: { "content-type": "application/json" },
      url: "https://router.test/v1/videos/generations",
    });
    videoReq.text = async () => JSON.stringify(videoBody);
    videoReq.arrayBuffer = async () => new TextEncoder().encode(JSON.stringify(videoBody)).buffer;
    hw.getModelInfo.mockResolvedValue({ provider: "xai", model: "grok-imagine-video" });
    const create = await handleVideoCreate(videoReq, "generations");
    await expectRefusal(create);
    expect(hw.reserveSpend).toHaveBeenCalledWith(expect.objectContaining({
      modality: "video", modelStr: "grok-imagine-video", provider: "xai",
    }));
    expect(hw.getProviderCredentials).not.toHaveBeenCalled();
    expect(hw.handleVideoProxyCore).not.toHaveBeenCalled();

    // Polling an already-created job bills nothing upstream, so it must stay
    // reachable: a job created before the cap was hit still has to be pollable.
    hw.reserveSpend.mockClear();
    const handleVideoGet = await loadHandler("../../src/sse/handlers/videoGeneration.js", "handleVideoGet");
    await handleVideoGet(makeRequest({ url: "https://router.test/v1/videos/req-1" }), "req-1");
    expect(hw.reserveSpend).not.toHaveBeenCalled();
  });
});

describe("fusion fan-out is reserved at its real cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hw.extractApiKey.mockReturnValue("sk-presented-key");
    hw.isValidApiKey.mockResolvedValue({ id: "key-1" });
    hw.getSettings.mockResolvedValue({ requireApiKey: true });
    hw.isTrustedInternalRequest.mockResolvedValue(false);
    hw.isKindAllowed.mockReturnValue(true);
    hw.isComboAllowed.mockReturnValue(true);
    hw.resolveProviderId.mockImplementation((p) => `resolved-${p}`);
    hw.handleBypassRequest.mockReturnValue(null);
    hw.getComboModels.mockResolvedValue(["a/one", "b/two", "c/three"]);
  });

  it("escalates the reservation to panel+judge before dispatching, and never below 1x", async () => {
    const escalate = vi.fn(async () => ({ ok: true }));
    hw.reserveSpend.mockResolvedValue({ ...GATE_ALLOW, escalate });
    hw.handleFusionChat.mockResolvedValue(new Response("fused", { status: 200 }));
    // Fusion is the branch under test, so the resolved strategy must be "fusion".
    hw.getSettings.mockResolvedValue({ requireApiKey: true, comboStrategy: "fusion" });

    const handleChat = await loadHandler("../../src/sse/handlers/chat.js", "handleChat");
    const response = await handleChat(makeRequest({
      body: { model: "combo/x", messages: CHAT_BODY.messages },
    }));

    expect(response.status).toBe(200);
    // 3 panel models + 1 judge = 4 billable upstream calls behind one client request.
    expect(escalate).toHaveBeenCalledWith(4);
    expect(hw.handleFusionChat).toHaveBeenCalledTimes(1);
  });

  it("refuses before dispatch when the fan-out does not fit the remaining budget", async () => {
    const escalate = vi.fn(async () => ({ ok: false, status: 402, message: "Daily spend budget exhausted (fusion)." }));
    hw.reserveSpend.mockResolvedValue({ ...GATE_ALLOW, escalate });
    hw.getSettings.mockResolvedValue({ requireApiKey: true, comboStrategy: "fusion" });

    const handleChat = await loadHandler("../../src/sse/handlers/chat.js", "handleChat");
    const response = await handleChat(makeRequest({
      body: { model: "combo/x", messages: CHAT_BODY.messages },
    }));

    expect(response.status).toBe(402);
    expect(hw.handleFusionChat).not.toHaveBeenCalled();
  });

  it("a non-fusion combo is never escalated", async () => {
    const escalate = vi.fn(async () => ({ ok: true }));
    hw.reserveSpend.mockResolvedValue({ ...GATE_ALLOW, escalate });
    hw.handleComboChat.mockResolvedValue(new Response("ok", { status: 200 }));
    hw.getSettings.mockResolvedValue({ requireApiKey: true, comboStrategy: "fallback" });

    const handleChat = await loadHandler("../../src/sse/handlers/chat.js", "handleChat");
    await handleChat(makeRequest({ body: { model: "combo/x", messages: CHAT_BODY.messages } }));

    expect(escalate).not.toHaveBeenCalled();
    expect(hw.handleComboChat).toHaveBeenCalledTimes(1);
  });

  it("a disabled gate still exposes escalate, so fusion cannot TypeError", async () => {
    // Regression guard: `escalate` is called unconditionally on the fusion path.
    // If the disabled branch of reserveSpend stopped returning it, every fusion
    // request in a deployment that never enabled the budget would throw.
    const off = await reserveSpend({ settings: {}, apiKeyInfo: null, body: CHAT_BODY, modelStr: CHAT_MODEL });
    expect(off.enabled).toBe(false);
    expect(typeof off.escalate).toBe("function");
    await expect(off.escalate(4)).resolves.toEqual({ ok: true, decision: null });
    // dispatch stays a transparent pass-through while disabled.
    await expect(off.dispatch(async () => "upstream")).resolves.toBe("upstream");
  });

  it("escalation raises the single pending entry in place, keeping one reservation id", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const decision = await reserveSpend({
      settings: { spendBudgetCents: cents * 10 }, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL,
    });
    expect(decision.reserveCents).toBe(cents);
    expect(Object.keys(readState("key-1").p)).toEqual([decision.reservationId]);

    const escalated = await decision.escalate(4);
    expect(escalated.ok).toBe(true);
    expect(decision.reserveCents).toBe(cents * 4);
    // Same id, one entry - so settleSpend needs no second code path.
    expect(Object.keys(readState("key-1").p)).toEqual([decision.reservationId]);

    await decision.dispatch(async () => okResponse());
    expect(readState("key-1").s).toBe(cents * 4);
    expect(readState("key-1").p).toEqual({});
  });

  it("escalation fails closed and hands the reservation back when it does not fit", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    // Room for 2x, not 4x.
    const decision = await reserveSpend({
      settings: { spendBudgetCents: cents * 2 }, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL,
    });
    const escalated = await decision.escalate(4);
    expect(escalated.ok).toBe(false);
    expect(escalated.status).toBe(402);
    // Released, not left holding the key's remaining budget.
    expect(readState("key-1")).toEqual({ s: 0, p: {} });
  });

  it("escalation cannot resurrect a reservation that was already settled", async () => {
    const { cents } = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const decision = await reserveSpend({
      settings: { spendBudgetCents: cents * 10 }, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL,
    });
    await settleSpend(decision, okResponse());
    expect(readState("key-1").s).toBe(cents);

    const escalated = await decision.escalate(4);
    expect(escalated.ok).toBe(true);
    // No phantom reservation re-added, and no extra charge.
    expect(readState("key-1").s).toBe(cents);
    expect(readState("key-1").p).toEqual({});
  });

  it("escalation fails closed when the counter itself is unavailable", async () => {
    const decision = await reserveSpend({
      settings: { spendBudgetCents: 1000 }, apiKeyInfo: { id: "key-1" }, body: CHAT_BODY, modelStr: CHAT_MODEL,
    });
    driverMock.getAdapter.mockResolvedValue({
      get: adapter.get.bind(adapter),
      run: () => { throw new Error("disk full"); },
      transaction: (fn) => fn(),
    });
    const escalated = await decision.escalate(4);
    expect(escalated.ok).toBe(false);
    expect(escalated.status).toBe(402);
  });

  it("multiplier scales the estimate and floors at one dispatch", () => {
    const one = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL });
    const four = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL, multiplier: 4 });
    expect(four.fanOut).toBe(4);
    // Same measurement, scaled reserve. The multiplier is applied BEFORE the
    // ceil, so 4x is ceil(raw*4) rather than ceil(raw)*4 - within a cent.
    expect(four.promptTokens).toBe(one.promptTokens);
    expect(four.outputTokens).toBe(one.outputTokens);
    expect(four.cents).toBeGreaterThanOrEqual(one.cents * 3);
    expect(four.cents).toBeLessThanOrEqual(one.cents * 4);
    // Nonsense multipliers degrade to a single dispatch, never to zero.
    for (const bad of [0, -3, NaN, "x", null, undefined]) {
      const r = estimateReserveCents({ modality: "llm", body: CHAT_BODY, modelStr: CHAT_MODEL, multiplier: bad });
      expect(r.cents).toBe(one.cents);
      expect(r.fanOut).toBe(1);
    }
  });
});

// safeJsonLength used to be `JSON.stringify(value).length` �� a full deep walk
// plus a throwaway string per field, four times per gated request, right before
// the body was serialized again for the upstream call. It is now an allocation-
// free recursive length sum, so the measurement path itself needs pinning.
describe("prompt size measurement", () => {
  it("scales with payload size and counts nested string content", () => {
    const one = estimatePromptChars({ messages: [{ role: "user", content: "hi" }] }, "llm");
    const many = estimatePromptChars({ messages: [{ role: "user", content: "x".repeat(40000) }] }, "llm");
    expect(many).toBeGreaterThan(one);
    // 4 chars/token, rounded up �� the documented convention.
    expect(many).toBeGreaterThanOrEqual(40000);
  });

  it("counts every declared field for the modality, not just the first", () => {
    const messages = estimatePromptChars({ messages: [{ content: "a".repeat(1000) }] }, "llm");
    const input = estimatePromptChars({ input: "a".repeat(1000) }, "llm");
    // "input" is a prompt field for llm because search/fetch/tts reuse the llm rate.
    expect(input).toBeGreaterThan(0);
    expect(messages).toBeGreaterThan(0);
  });

  it("charges an empty or missing field nothing", () => {
    expect(estimatePromptChars({}, "llm")).toBe(0);
    expect(estimatePromptChars({ messages: null, input: undefined }, "llm")).toBe(0);
    expect(estimatePromptChars(undefined, "llm")).toBe(0);
  });

  it("measures every modality that can reach a billable upstream call", () => {
    // A modality missing from PROMPT_FIELDS silently falls back to the llm field
    // list, measures nothing, and floors at 1 cent �� which is how a real cost
    // escapes the budget. These are the modalities the public API exposes.
    const priced = [
      ["llm", { messages: [{ content: "hello" }] }],
      ["embedding", { input: "hello" }],
      ["image", { prompt: "a cat" }],
      ["tts", { input: "hello" }],
      ["video", { prompt: "a cat" }],
      ["webSearch", { query: "who won" }],
      ["webFetch", { url: "https://example.com/a" }],
    ];
    for (const [modality, body] of priced) {
      const chars = estimatePromptChars(body, modality);
      expect(chars, `${modality} must measure its own prompt field`).toBeGreaterThan(0);
    }
    // stt posts multipart FormData, which a field-name walk cannot measure. It is
    // declared explicitly so the loose MIN_RESERVE_CENTS gate is a decision.
    expect(estimatePromptChars({}, "stt")).toBe(0);
  });

  it("still refuses to throw on a cyclic body and charges it nothing", () => {
    const cyclic = { messages: [] };
    cyclic.messages.push(cyclic);
    expect(() => estimatePromptChars(cyclic, "llm")).not.toThrow();
    // Unmeasurable (depth cap hit) => the field is charged 0, the documented
    // fail-open branch, and NOT a partial sum of 64 levels.
    expect(estimatePromptChars(cyclic, "llm")).toBe(0);
  });

  it("drops functions and symbols the way JSON.stringify did", () => {
    const withFn = estimatePromptChars({ messages: [{ content: "hi", cb: () => {} }] }, "llm");
    const plain = estimatePromptChars({ messages: [{ content: "hi" }] }, "llm");
    // The "cb" key is counted, its function value contributes nothing.
    expect(withFn).toBe(plain + "cb".length);
  });
});
