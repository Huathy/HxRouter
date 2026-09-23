// Migration 009: add latencyMs column to usageHistory.
// Idempotent — safe to re-run on existing databases.
export default {
  version: 9,
  name: "add-usage-latency",
  up(db) {
    const cols = db.all(`PRAGMA table_info(usageHistory)`);
    if (!cols.some((c) => c.name === "latencyMs")) {
      db.exec(`ALTER TABLE usageHistory ADD COLUMN latencyMs REAL DEFAULT 0`);
    }
  },
};
