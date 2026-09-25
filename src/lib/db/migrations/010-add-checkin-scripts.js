export default {
  version: 10,
  name: "add-checkin-scripts",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS checkinScripts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      scheduleType TEXT NOT NULL,
      cronExpr TEXT,
      timezone TEXT NOT NULL,
      nextRunAt INTEGER,
      lastRunAt INTEGER,
      data TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS checkinRuns (
      id TEXT PRIMARY KEY,
      scriptId TEXT NOT NULL,
      triggerType TEXT NOT NULL,
      status TEXT NOT NULL,
      queuedAt INTEGER NOT NULL,
      startedAt INTEGER,
      finishedAt INTEGER,
      durationMs INTEGER,
      httpStatus INTEGER,
      summary TEXT,
      errorCode TEXT,
      errorMessage TEXT,
      data TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cs_enabled ON checkinScripts(enabled)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cs_next_run ON checkinScripts(nextRunAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cr_script ON checkinRuns(scriptId, queuedAt DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cr_status ON checkinRuns(status)`);
  },
};
