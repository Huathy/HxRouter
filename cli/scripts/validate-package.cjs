#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const [tarball, expectedVersion] = process.argv.slice(2);

if (!tarball || !expectedVersion) {
  throw new Error("Usage: validate-package.cjs <tarball> <version>");
}
if (!fs.existsSync(tarball)) {
  throw new Error(`Tarball does not exist: ${tarball}`);
}

// The bundled CLI ships ~14k files, so the full `tar -tzf` listing is >1 MB.
// Node's execFileSync defaults to a 1 MB stdout buffer and fails with ENOBUFS
// before any assertion runs. Raise the limit, and strip CR so the gate behaves the
// same on Windows (bsdtar emits CRLF) as on the Linux runner. Checks are unchanged.
const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .replace(/\r/g, "")
  .trim()
  .split("\n")
  .filter(Boolean);
const requiredWasm = "package/app/_nm/sql.js/dist/sql-wasm.wasm";

if (!entries.includes(requiredWasm)) {
  throw new Error(`sql.js WASM missing from final CLI package: ${requiredWasm}`);
}
if (entries.some((entry) => /(^|\/)better_sqlite3\.node$/.test(entry))) {
  throw new Error("native better-sqlite3 leaked into final CLI package");
}

const packageJson = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
  encoding: "utf8",
}));
if (packageJson.name !== "hxrouter") {
  throw new Error(`Unexpected package name: ${packageJson.name}`);
}
if (packageJson.version !== expectedVersion) {
  throw new Error(`Tarball version mismatch: ${packageJson.version} !== ${expectedVersion}`);
}

const expectedFilename = `hxrouter-${expectedVersion}.tgz`;
if (path.basename(tarball) !== expectedFilename) {
  throw new Error(`Tarball filename mismatch: ${path.basename(tarball)} !== ${expectedFilename}`);
}

console.log(`Validated ${packageJson.name}@${packageJson.version}: ${tarball}`);
