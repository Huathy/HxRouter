// Shared teardown for tests that point DATA_DIR at a scratch directory.
//
// Windows keeps a running SQLite handle on data.sqlite (plus -wal/-shm), and
// `fs.rmSync(dir, { recursive: true, force: true })` still fails with EPERM on a
// locked directory — `force` only suppresses ENOENT. Closing the process-wide
// adapter first lets the assertions keep running on every platform instead of
// being skipped.
import fs from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Close the shared DB adapter, reset the module registry, then delete `tempDir`.
 * Restoring DATA_DIR is left to the caller so each suite keeps its own
 * beforeAll/afterAll shape.
 */
export async function cleanupTempDb(tempDir, { attempts = 5 } = {}) {
  if (!tempDir) return;
  const { closeAdapter } = await import("@/lib/db/driver.js");
  await closeAdapter().catch(() => {});

  for (let i = 0; ; i++) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err?.code !== "EPERM" && err?.code !== "EBUSY") || i >= attempts - 1) throw err;
      await sleep(50 * (i + 1));
    }
  }
}
