import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalAutomationKey = process.env.AUTOMATION_SECRET_KEY;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-checkin-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalAutomationKey === undefined) delete process.env.AUTOMATION_SECRET_KEY;
  else process.env.AUTOMATION_SECRET_KEY = originalAutomationKey;
});

describe("checkin repository", () => {
  it("persists scripts and atomically claims one due run", async () => {
    const repo = await import("../../src/lib/db/repos/checkinRepo.js");
    const now = 1_800_000_000_000;
    const script = await repo.createCheckinScript({
      name: "Daily",
      enabled: true,
      scheduleType: "cron",
      cronExpr: "0 8 * * *",
      timezone: "Asia/Shanghai",
      nextRunAt: now,
      config: { url: "https://example.com/check-in", method: "POST" },
      secretCiphertext: "v1.encrypted",
    });

    expect((await repo.getCheckinScriptById(script.id)).config.url).toBe("https://example.com/check-in");

    const claimed = await repo.claimDueCheckinScript(script.id, now, now + 86_400_000, "schedule");
    expect(claimed).not.toBeNull();
    expect(claimed.run.status).toBe("queued");
    expect((await repo.getCheckinScriptById(script.id)).nextRunAt).toBe(now + 86_400_000);

    const duplicate = await repo.claimDueCheckinScript(script.id, now, now + 172_800_000, "schedule");
    expect(duplicate).toBeNull();
    expect(await repo.deleteCheckinScript(script.id)).toEqual({ busy: true });
    expect(await repo.getCheckinScriptById(script.id)).not.toBeNull();

    await repo.finishCheckinRun(claimed.run.id, {
      status: "succeeded",
      startedAt: now + 1,
      finishedAt: now + 100,
      durationMs: 99,
      httpStatus: 200,
      summary: "checked in",
    });

    const runs = await repo.listCheckinRuns(script.id, 20);
    expect(runs[0]).toMatchObject({ status: "succeeded", httpStatus: 200, summary: "checked in" });
  });

  it("requeues interrupted scheduled runs", async () => {
    const repo = await import("../../src/lib/db/repos/checkinRepo.js");
    const now = Date.now();
    const script = await repo.createCheckinScript({
      name: "Recovery",
      enabled: true,
      scheduleType: "cron",
      cronExpr: "0 8 * * *",
      timezone: "UTC",
      nextRunAt: now,
      config: { url: "https://example.com/check-in", method: "GET" },
    });
    const claimed = await repo.claimDueCheckinScript(script.id, now, now + 86_400_000, "schedule");
    await repo.markInterruptedCheckinRuns(Date.now() + 10_000);
    const runs = await repo.listCheckinRuns(script.id, 1);
    const restored = await repo.getCheckinScriptById(script.id);

    expect(runs[0].status).toBe("interrupted");
    expect(restored.nextRunAt).toBeLessThanOrEqual(Date.now());
    expect(claimed.run.status).toBe("queued");
  });

  it("rebuilds imported schedules and rejects an incompatible secret key", async () => {
    const repo = await import("../../src/lib/db/index.js");
    const { encryptCheckinSecret } = await import("../../src/lib/checkin/secretCrypto.js");
    const key = randomBytes(32).toString("base64");
    process.env.AUTOMATION_SECRET_KEY = key;
    const script = await repo.createCheckinScript({
      id: "imported-script",
      name: "Imported",
      enabled: true,
      scheduleType: "cron",
      cronExpr: "0 8 * * *",
      timezone: "UTC",
      nextRunAt: 1,
      config: { url: "https://example.com/check-in", method: "GET", headers: {} },
      secretCiphertext: encryptCheckinSecret("token"),
    });
    const snapshot = await repo.exportDb();
    expect(snapshot.checkinScripts[0].secretCiphertext).toBe("");
    expect(snapshot.checkinScripts[0].config.bodyOmitted).toBe(true);
    const encryptedSnapshot = structuredClone(snapshot);
    encryptedSnapshot.checkinScripts[0].secretCiphertext = encryptCheckinSecret("token");
    process.env.AUTOMATION_SECRET_KEY = randomBytes(32).toString("base64");
    await expect(repo.importDb(encryptedSnapshot)).rejects.toThrow();
    process.env.AUTOMATION_SECRET_KEY = key;
    await repo.importDb(snapshot);
    const restored = await repo.getCheckinScriptById(script.id);
    expect(restored.nextRunAt).toBeGreaterThan(Date.now());
  });
});
