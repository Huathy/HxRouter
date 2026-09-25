import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-checkin-runner-"));
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
});

describe("checkin runner", () => {
  it("persists success from a manual run", async () => {
    const repo = await import("../../src/lib/db/repos/checkinRepo.js");
    const { executeCheckinRun } = await import("../../src/lib/checkin/runner.js");
    const script = await repo.createCheckinScript({
      name: "Runner",
      enabled: false,
      scheduleType: "manual",
      timezone: "UTC",
      config: {
        url: "https://example.com/check-in",
        method: "POST",
        headers: {},
        body: "",
        expectedStatus: [200],
        successPattern: "success",
        timeoutSeconds: 30,
      },
    });
    const run = await repo.createManualCheckinRun(script.id);
    const result = await executeCheckinRun(script, run, {
      fetchImpl: vi.fn(async () => new Response("success", { status: 200 })),
    });

    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("HTTP 200 · success");
  });
});
