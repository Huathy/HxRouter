const fs = require("fs");
const path = require("path");

// Guard against source files that are not valid UTF-8.
//
// Why: webpack's "Failed to read source code ... stream did not contain valid
// UTF-8" surfaces 40s into a Docker build, long after the real cause. The usual
// trigger is a merge or a Windows editor writing back through a lossy codepage,
// which mangles multi-byte sequences (U+2192/U+2014 become "?", or a raw GBK
// A1AA em dash lands in an otherwise-UTF-8 file). Only files webpack actually
// imports fail the build, so the error names one file at a time and hides the
// rest. Check the whole tree up front and report every offender at once.
//
// Binary files are skipped by extension rather than sniffed: NUL bytes in a
// "text" file mean corruption, and the repo's binary assets (.png/.webp/.ico/
// .ttf) are all covered by this list.

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", ".fakehome", ".kilocode", ".kilo",
  ".agent", "coverage", "dist", "out", "data", "logs", "_nm",
]);

const TEXT_EXT = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".md", ".mdx",
  ".css", ".scss", ".html", ".yml", ".yaml", ".txt", ".sh", ".ps1", ".sql",
]);

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".svgz", ".ttf",
  ".otf", ".woff", ".woff2", ".eot", ".zip", ".gz", ".tar", ".wasm", ".so",
  ".dylib", ".dll", ".exe", ".bin", ".db", ".sqlite", ".pdf",
]);

const root = path.resolve(__dirname, "..");
const offenders = [];
let scanned = 0;

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    if (!TEXT_EXT.has(ext) && path.basename(entry.name) !== "Dockerfile") continue;

    const buf = fs.readFileSync(full);
    scanned++;
    // Decode line by line with a strict decoder so the report can name the
    // offending line, and so one bad file does not hide the rest.
    let badLine = -1;
    let offset = 0;
    for (const chunk of buf.toString("latin1").split("\n")) {
      const raw = Buffer.from(chunk, "latin1");
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        badLine = offset;
        break;
      }
      offset += chunk.length + 1;
    }
    if (badLine >= 0) {
      const line = buf.subarray(0, badLine).filter((b) => b === 0x0a).length + 1;
      offenders.push(`${path.relative(root, full)}:${line}`);
    }
  }
}

walk(root);

if (offenders.length) {
  console.error("Non-UTF-8 source files (webpack will fail to read these):");
  for (const file of offenders) console.error(`  ${file}`);
  console.error(
    "\nRe-save these as UTF-8. A merge or editor running a lossy codepage (e.g. GBK)\n" +
    "is the usual cause; `git checkout -- <file>` restores a known-good copy if\n" +
    "the content is unchanged, otherwise re-encode the file as UTF-8."
  );
  process.exit(1);
}

console.log(`utf-8 check: clean (${scanned} files)`);
