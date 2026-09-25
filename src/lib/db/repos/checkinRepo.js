import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const ACTIVE_STATUSES = ["queued", "running"];

function rowToScript(row) {
  if (!row) return null;
  const data = parseJson(row.data, {});
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    scheduleType: row.scheduleType,
    cronExpr: row.cronExpr || "",
    timezone: row.timezone,
    nextRunAt: row.nextRunAt ?? null,
    lastRunAt: row.lastRunAt ?? null,
    config: data.config || {},
    secretCiphertext: data.secretCiphertext || "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    scriptId: row.scriptId,
    triggerType: row.triggerType,
    status: row.status,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    durationMs: row.durationMs ?? null,
    httpStatus: row.httpStatus ?? null,
    summary: row.summary || "",
    errorCode: row.errorCode || "",
    errorMessage: row.errorMessage || "",
    secretConfigured: parseJson(row.data, {}).secretConfigured,
  };
}

function insertRun(db, run) {
  db.run(
    `INSERT INTO checkinRuns(id, scriptId, triggerType, status, queuedAt, startedAt, finishedAt, durationMs, httpStatus, summary, errorCode, errorMessage, data)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      run.scriptId,
      run.triggerType,
      run.status,
      run.queuedAt,
      run.startedAt ?? null,
      run.finishedAt ?? null,
      run.durationMs ?? null,
      run.httpStatus ?? null,
      run.summary || "",
      run.errorCode || "",
      run.errorMessage || "",
      stringifyJson({ configSnapshot: run.configSnapshot || {}, secretConfigured: run.secretConfigured === true }),
    ],
  );
  return run;
}

function hasActiveRun(db, scriptId) {
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
  return Boolean(db.get(
    `SELECT id FROM checkinRuns WHERE scriptId = ? AND status IN (${placeholders}) LIMIT 1`,
    [scriptId, ...ACTIVE_STATUSES],
  ));
}

export async function listCheckinScripts() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM checkinScripts ORDER BY createdAt DESC`).map(rowToScript);
}

export async function getCheckinScriptById(id) {
  const db = await getAdapter();
  return rowToScript(db.get(`SELECT * FROM checkinScripts WHERE id = ?`, [id]));
}

export async function createCheckinScript(input) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const script = {
    id: input.id || randomUUID(),
    name: input.name,
    enabled: input.enabled === true,
    scheduleType: input.scheduleType,
    cronExpr: input.cronExpr || "",
    timezone: input.timezone,
    nextRunAt: input.nextRunAt ?? null,
    lastRunAt: null,
    config: input.config || {},
    secretCiphertext: input.secretCiphertext || "",
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO checkinScripts(id, name, enabled, scheduleType, cronExpr, timezone, nextRunAt, lastRunAt, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      script.id,
      script.name,
      script.enabled ? 1 : 0,
      script.scheduleType,
      script.cronExpr,
      script.timezone,
      script.nextRunAt,
      script.lastRunAt,
      stringifyJson({ config: script.config, secretCiphertext: script.secretCiphertext }),
      script.createdAt,
      script.updatedAt,
    ],
  );
  return script;
}

export async function updateCheckinScript(id, updates) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const existing = rowToScript(db.get(`SELECT * FROM checkinScripts WHERE id = ?`, [id]));
    if (!existing) return;
    const script = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    db.run(
      `UPDATE checkinScripts SET name = ?, enabled = ?, scheduleType = ?, cronExpr = ?, timezone = ?, nextRunAt = ?, data = ?, updatedAt = ? WHERE id = ?`,
      [
        script.name,
        script.enabled ? 1 : 0,
        script.scheduleType,
        script.cronExpr || "",
        script.timezone,
        script.nextRunAt ?? null,
        stringifyJson({ config: script.config || {}, secretCiphertext: script.secretCiphertext || "" }),
        script.updatedAt,
        id,
      ],
    );
    result = script;
  });
  return result;
}

export async function deleteCheckinScript(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const existing = rowToScript(db.get(`SELECT * FROM checkinScripts WHERE id = ?`, [id]));
    if (!existing) return;
    if (hasActiveRun(db, id)) {
      removed = { busy: true };
      return;
    }
    db.run(`DELETE FROM checkinRuns WHERE scriptId = ?`, [id]);
    db.run(`DELETE FROM checkinScripts WHERE id = ?`, [id]);
    removed = existing;
  });
  return removed;
}

export async function listDueCheckinScripts(now, limit = 20) {
  const db = await getAdapter();
  return db.all(
    `SELECT * FROM checkinScripts WHERE enabled = 1 AND scheduleType = 'cron' AND nextRunAt IS NOT NULL AND nextRunAt <= ? ORDER BY nextRunAt LIMIT ?`,
    [now, limit],
  ).map(rowToScript);
}

export async function claimDueCheckinScript(id, expectedNextRunAt, nextRunAt, triggerType = "schedule") {
  const db = await getAdapter();
  let claimed = null;
  db.transaction(() => {
    const scriptRow = db.get(`SELECT * FROM checkinScripts WHERE id = ?`, [id]);
    if (!scriptRow || scriptRow.enabled !== 1 || scriptRow.nextRunAt !== expectedNextRunAt || hasActiveRun(db, id)) return;
    const run = insertRun(db, {
      id: randomUUID(),
      scriptId: id,
      triggerType,
      status: "queued",
      queuedAt: Date.now(),
       configSnapshot: rowToScript(scriptRow).config,
       secretConfigured: Boolean(rowToScript(scriptRow).secretCiphertext),
     });
    db.run(`UPDATE checkinScripts SET nextRunAt = ?, updatedAt = ? WHERE id = ?`, [nextRunAt, new Date().toISOString(), id]);
    claimed = { script: rowToScript(scriptRow), run: rowToRun(db.get(`SELECT * FROM checkinRuns WHERE id = ?`, [run.id])) };
  });
  return claimed;
}

export async function createManualCheckinRun(scriptId) {
  const db = await getAdapter();
  let created = null;
  db.transaction(() => {
    const script = rowToScript(db.get(`SELECT * FROM checkinScripts WHERE id = ?`, [scriptId]));
    if (!script || hasActiveRun(db, scriptId)) return;
    created = insertRun(db, {
      id: randomUUID(),
      scriptId,
      triggerType: "manual",
      status: "queued",
      queuedAt: Date.now(),
      configSnapshot: script.config,
      secretConfigured: Boolean(script.secretCiphertext),
    });
  });
  return created ? rowToRun(created) : null;
}

export async function markCheckinRunRunning(runId, startedAt = Date.now()) {
  const db = await getAdapter();
  db.run(
    `UPDATE checkinRuns SET status = 'running', startedAt = ? WHERE id = ? AND status = 'queued'`,
    [startedAt, runId],
  );
  return rowToRun(db.get(`SELECT * FROM checkinRuns WHERE id = ?`, [runId]));
}

export async function finishCheckinRun(runId, result) {
  const db = await getAdapter();
  let updated = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM checkinRuns WHERE id = ?`, [runId]);
    if (!row) return;
    db.run(
      `UPDATE checkinRuns SET status = ?, startedAt = ?, finishedAt = ?, durationMs = ?, httpStatus = ?, summary = ?, errorCode = ?, errorMessage = ? WHERE id = ?`,
      [
        result.status,
        result.startedAt ?? row.startedAt ?? null,
        result.finishedAt ?? null,
        result.durationMs ?? null,
        result.httpStatus ?? null,
        result.summary || "",
        result.errorCode || "",
        result.errorMessage || "",
        runId,
      ],
    );
    if (row.scriptId) db.run(`UPDATE checkinScripts SET lastRunAt = ? WHERE id = ?`, [result.finishedAt ?? null, row.scriptId]);
    updated = rowToRun(db.get(`SELECT * FROM checkinRuns WHERE id = ?`, [runId]));
  });
  return updated;
}

export async function listCheckinRuns(scriptId, limit = 50) {
  const db = await getAdapter();
  return db.all(
    `SELECT * FROM checkinRuns WHERE scriptId = ? ORDER BY queuedAt DESC LIMIT ?`,
    [scriptId, Math.max(1, Math.min(100, Number(limit) || 50))],
  ).map(rowToRun);
}

export async function markInterruptedCheckinRuns(before = Date.now()) {
  const db = await getAdapter();
  const now = Date.now();
  const rows = db.all(
    `SELECT id, scriptId, triggerType FROM checkinRuns WHERE status IN ('queued', 'running') AND queuedAt < ?`,
    [before],
  );
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      db.run(
        `UPDATE checkinRuns SET status = 'interrupted', finishedAt = ?, errorCode = 'INTERRUPTED', errorMessage = 'Application restarted during execution' WHERE id = ?`,
        [now, row.id],
      );
      if (row.triggerType === "schedule") {
        db.run(`UPDATE checkinScripts SET nextRunAt = ?, updatedAt = ? WHERE id = ? AND enabled = 1`, [now, new Date(now).toISOString(), row.scriptId]);
      }
      changed += 1;
    }
  });
  return { changes: changed };
}
