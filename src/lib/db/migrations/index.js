// Migration registry — append new entries when schema changes.
// Each migration: { version: number, name: string, up(db): void }
// Versions MUST be unique and monotonically increasing.
import m001 from "./001-initial.js";
import m002 from "./002-fix-empty-allowed-lists.js";
import m003 from "./003-add-allowed-lists-columns.js";
import m004 from "./004-add-request-details-apikey.js";
import m007 from "./007-add-combo-context-length.js";
import m008 from "./008-add-proxy-pool-fitness.js";
import m009 from "./009-add-usage-latency.js";
import m010 from "./010-add-checkin-scripts.js";

export const MIGRATIONS = [m001, m002, m003, m004, m007, m008, m009, m010].sort((a, b) => a.version - b.version);

export function latestVersion() {
  return MIGRATIONS.reduce((latest, migration) => Math.max(latest, migration.version), 0);
}
