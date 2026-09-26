// ─────────────────────────────────────────────────────────────────────────────
// DB driver contract (§5.4) — "ran the wrong driver → silently wrong data".
// driver.js picks the engine at runtime (bun:sqlite → better-sqlite3 →
// node:sqlite → sql.js) and the first one that loads becomes the process-wide
// adapter. Nothing else in the app notices a swap, so this suite pins each
// adapter's observable behaviour against one canonical EXPECTED object, then
// deep-compares every driver that ran against each other.
//
// HONEST SCOPE: bun:sqlite needs Bun, node:sqlite needs Node >= 22.5, and
// better-sqlite3 is an optional native dep. Each driver is guarded and reported
// individually — one that cannot load is SKIPPED with its reason printed, never
// silently counted as covered. 4-driver parity is only proven on an image that
// has all four; on this machine 3/4 run.
//
// Verified source facts this leans on: (a) createBetterSqliteAdapter is a
// *synchronous* export function while the other three are `export async
// function`, so every call site is `await create(...)` — a no-op on a
// non-promise; (b) sql.js is in-memory (SAVE_DEBOUNCE_MS = 100) with no WAL, so
// its durability point is close() and it has no checkpoint() (see KNOWN GAP);
// (c) DATA_DIR must be redirected before paths.js loads, so no import below may
// transitively reach it — every db module is reached via dynamic import.
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it, expect, afterAll } from "vitest";

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-driver-contract-"));
const PREV_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEMP_DIR;
fs.mkdirSync(path.join(TEMP_DIR, "db"), { recursive: true });

const nodeRequire = createRequire(import.meta.url);
const canLoad = (s) => { try { nodeRequire(s); return true; } catch { return false; } };
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split(".").map(Number);
const nodeSqlitePresent = NODE_MAJOR > 22 || (NODE_MAJOR === 22 && NODE_MINOR >= 5);

const DRIVERS = [
  { id: "better-sqlite3", wal: true, available: canLoad("better-sqlite3"),
    why: "optional native dep better-sqlite3 did not load (try `pnpm rebuild better-sqlite3`)",
    load: () => import("@/lib/db/adapters/betterSqliteAdapter.js").then((m) => m.createBetterSqliteAdapter) },
  { id: "node:sqlite", wal: true, available: nodeSqlitePresent,
    why: "requires the Node >= 22.5 builtin node:sqlite",
    load: () => import("@/lib/db/adapters/nodeSqliteAdapter.js").then((m) => m.createNodeSqliteAdapter) },
  { id: "bun:sqlite", wal: true, available: !!process.versions.bun,
    why: "requires the Bun runtime (bun:sqlite is a Bun builtin)",
    load: () => import("@/lib/db/adapters/bunSqliteAdapter.js").then((m) => m.createBunSqliteAdapter) },
  { id: "sql.js", wal: false, available: canLoad("sql.js"), why: "sql.js did not load",
    load: () => import("@/lib/db/adapters/sqljsAdapter.js").then((m) => m.createSqlJsAdapter) },
];
// Surfaced in the describe title so a skipped driver is impossible to miss.
for (const d of DRIVERS) d.status = d.available ? "contract enforced" : `SKIPPED (${d.why})`;

let fileSeq = 0;
const openAt = async (d, file) => await (await d.load())(file); // uniform await: see header
const open = (d, label) => {
  const file = path.join(TEMP_DIR, "db", `${label}-${++fileSeq}.sqlite`);
  return openAt(d, file).then((adapter) => ({ adapter, file }));
};
const closeSafe = (a) => { try { a.close(); } catch { /* already closed */ } };
const attempt = (fn) => { try { return { value: fn() }; } catch (e) { return { error: e.message }; } };
const REQUIRED_TABLES = ["_meta", "settings", "providerConnections", "providerNodes", "proxyPools",
  "proxyPoolFitness", "checkinScripts", "checkinRuns", "apiKeys", "combos", "kv", "usageHistory",
  "usageDaily", "requestDetails"];

// The canonical contract: what every driver must observably return.
const EXPECTED = {
  insert: { changes: 1, lastInsertRowid: 1 },
  row: { id: 1, name: "one", n: 10 },
  updateChanges: 1,
  missingRowIsUndefined: true,
  emptyAll: [],
  tx: { value: "committed" },
  afterCommit: [1, 2],
  rollback: { error: "rollback-me" },
  afterRollback: [1, 2],
  usableAfterRollback: true,
  deleteChanges: 1,
};

afterAll(async () => {
  if (PREV_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = PREV_DATA_DIR;
  // Windows may still hold a handle; leaking a temp dir beats a red suite.
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 60 * (i + 1))); }
  }
});

describe("DB driver contract", () => {
  it("reports which drivers this machine can actually exercise", () => {
    const ran = DRIVERS.filter((d) => d.available).map((d) => d.id);
    const skipped = DRIVERS.filter((d) => !d.available).map((d) => `${d.id} (${d.why})`);
    console.log(`[db-driver-contract] node ${process.versions.node} | ran: ${ran.join(", ") || "none"}`);
    if (skipped.length) console.log(`[db-driver-contract] skipped: ${skipped.join("; ")}`);
    // The suite must never be a silent no-op.
    expect(ran.length, "no SQLite driver could be loaded — contract unproven").toBeGreaterThan(0);
  });

  it("every driver that runs matches the canonical contract and each other", async () => {
    const observed = {};
    for (const d of DRIVERS.filter((x) => x.available)) {
      const { adapter } = await open(d, "crosscheck");
      try { observed[d.id] = observe(adapter); } finally { closeSafe(adapter); }
    }
    const [reference, ...rest] = Object.keys(observed);
    // Non-vacuity guard: the reference must be a real result, not an empty
    // object two drivers happen to agree on.
    expect(observed[reference]).toEqual(EXPECTED);
    for (const id of rest) {
      expect(observed[id], `driver "${id}" diverged from "${reference}"`).toEqual(observed[reference]);
    }
    console.log(`[db-driver-contract] identical behaviour verified across: ${[reference, ...rest].join(", ")}`);
  });
});

describe.each(DRIVERS)("$id — $status", (d) => {
  it.skipIf(!d.available)("exposes the shared adapter surface", async () => {
    const { adapter } = await open(d, "surface");
    try {
      expect(adapter.driver, "adapter.driver must name the engine that actually ran").toBe(d.id);
      for (const m of ["run", "get", "all", "exec", "transaction", "close"]) {
        expect(typeof adapter[m], `${d.id} is missing ${m}()`).toBe("function");
      }
      expect(adapter.raw, `${d.id} is missing raw`).toBeTruthy();
    } finally { closeSafe(adapter); }
  });

  it.skipIf(!d.available)("migrates a fresh database to the current schema (idempotently)", async () => {
    const [{ runMigrationOnce }, { latestVersion }] = await Promise.all([
      import("@/lib/db/migrate.js"), import("@/lib/db/migrations/index.js"),
    ]);
    const { adapter } = await open(d, "migrate");
    const version = () => Number(adapter.get("SELECT value FROM _meta WHERE key='schemaVersion'")?.value);
    try {
      await runMigrationOnce(adapter);
      expect(version(), `${d.id} did not reach the latest schema version`).toBe(latestVersion());
      const tables = adapter.all("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
      for (const t of REQUIRED_TABLES) expect(tables, `${d.id} is missing table ${t}`).toContain(t);
      await runMigrationOnce(adapter); // re-run must not corrupt or re-apply anything
      expect(version()).toBe(latestVersion());
    } finally { closeSafe(adapter); }
  });

  it.skipIf(!d.available)("CRUD + transaction() match the canonical contract", async () => {
    const { adapter } = await open(d, "contract");
    try { expect(observe(adapter), `${d.id} diverged from the driver contract`).toEqual(EXPECTED); }
    finally { closeSafe(adapter); }
  });

  it.skipIf(!d.available)("close() flushes to disk, is idempotent, and locks the handle", async () => {
    const { adapter, file } = await open(d, "durability");
    adapter.exec("CREATE TABLE d(k TEXT PRIMARY KEY, v TEXT)");
    adapter.run("INSERT INTO d(k, v) VALUES(?, ?)", ["k1", "v1"]);
    // close() is the forced-flush point — mandatory for sql.js (100ms debounce).
    adapter.close();
    const reopened = await openAt(d, file);
    try { expect(reopened.get("SELECT v FROM d WHERE k = ?", ["k1"])?.v, `${d.id} lost the row on close()`).toBe("v1"); }
    finally { closeSafe(reopened); }
    expect(() => adapter.close(), `${d.id}.close() is not idempotent`).not.toThrow();
    expect(() => adapter.get("SELECT 1"), `${d.id} still answers after close()`).toThrow();
  });

  it.skipIf(!d.available || !d.wal)("checkpoint() flushes without ending the session", async () => {
    const { adapter } = await open(d, "checkpoint");
    try {
      expect(typeof adapter.checkpoint, `${d.id} has no checkpoint()`).toBe("function");
      adapter.exec("CREATE TABLE c(k INTEGER)");
      adapter.run("INSERT INTO c(k) VALUES(1)");
      expect(() => adapter.checkpoint()).not.toThrow();
      expect(adapter.get("SELECT k FROM c WHERE k = 1")?.k).toBe(1);
    } finally { closeSafe(adapter); }
  });
});

const SQLJS = DRIVERS.find((d) => d.id === "sql.js");
// KNOWN GAP (asserted so it cannot be forgotten): sql.js is an in-memory engine
// with no WAL, so it has no wal_checkpoint to expose — betterSqliteAdapter:56,
// nodeSqliteAdapter:86 and bunSqliteAdapter:56 all have `checkpoint()` and
// sqljsAdapter.js has none; its durability point is close() (dirty → persist()).
// DELETE this test when `checkpoint()` is added to sqljsAdapter.js — that driver
// must then also pass the checkpoint() test above.
it.skipIf(!SQLJS.available)("KNOWN GAP: sql.js exposes no checkpoint() (in-memory, flushes on close)", async () => {
  const { adapter } = await open(SQLJS, "nocheckpoint");
  try { expect(adapter.checkpoint).toBeUndefined(); } finally { closeSafe(adapter); }
});

// The driver-agnostic probe behind both EXPECTED and the cross-driver compare.
// Deliberately skips the migration so the comparison isolates adapter semantics.
function observe(a) {
  a.exec("CREATE TABLE p(id INTEGER PRIMARY KEY, name TEXT, n INTEGER)");
  const add = (id, name, n) => a.run("INSERT INTO p(id, name, n) VALUES(?, ?, ?)", [id, name, n]);
  const ids = () => a.all("SELECT id FROM p ORDER BY id").map((x) => x.id);
  const insert = add(1, "one", 10);
  const r = {
    insert: { changes: Number(insert.changes), lastInsertRowid: Number(insert.lastInsertRowid) },
    row: a.get("SELECT id, name, n FROM p WHERE id = ?", [1]),
    updateChanges: Number(a.run("UPDATE p SET n = ? WHERE id = ?", [20, 1]).changes),
    missingRowIsUndefined: a.get("SELECT id FROM p WHERE id = ?", [999]) === undefined,
    emptyAll: a.all("SELECT id FROM p WHERE n < 0"),
  };
  r.tx = attempt(() => a.transaction(() => { add(2, "two", 2); return "committed"; }));
  r.afterCommit = ids();
  r.rollback = attempt(() => a.transaction(() => { add(3, "three", 3); throw new Error("rollback-me"); }));
  r.afterRollback = ids();
  // A rolled-back transaction must leave a working handle, not a poisoned one.
  r.usableAfterRollback = attempt(() => add(4, "four", 4)).value !== undefined;
  r.deleteChanges = Number(a.run("DELETE FROM p WHERE id = ?", [1]).changes);
  return r;
}
