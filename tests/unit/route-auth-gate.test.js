import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

/**
 * Defence-in-depth gate for dashboard auth on API route handlers.
 *
 * `src/proxy.js` + `src/dashboardGuard.js` are the deny-by-default first line.
 * This suite is the second line: it protects against (a) a future matcher
 * change that widens the proxy, and (b) a new route being added without auth.
 *
 * Why AST and not a string search:
 *   A `src.includes("requireDashboardAuth")` check passes even when the call is
 *   unreachable, lives in an unused helper, or sits after an early `return`.
 *   This suite parses each file with espree and asserts the call is the FIRST
 *   statement of the exported HTTP handler's body — i.e. before any body
 *   parsing, any `spawn`, any `execSync`, any DB read.
 *
 * Parser choice: espree is not hoisted to the repo root under pnpm; it lives in
 * eslint's own node_modules and is reached through eslint's resolved entry.
 * No new dependency is added. Same "load a real parser from the toolchain"
 * approach as tests/unit/eslint-undef-config.test.js, which drives eslint's
 * Linter over eslint.config.mjs.
 *
 * KNOWN LIMITATION (accepted, not fixed):
 *   This is a syntax check, not a semantic one. A route can keep the guard as
 *   its first statement and still be broken — e.g. by negating the result, by
 *   ignoring the returned value, or by gating on a predicate the auth helper
 *   never controls. The gate proves the call is present and first; it cannot
 *   prove the handler honours it. Runtime behaviour is covered separately.
 */

const require = createRequire(import.meta.url);
const espree = createRequire(require.resolve("eslint"))("espree");

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/**
 * Every route this suite owns. `cli-tools/*-settings` was enumerated with a
 * glob, not hand-listed: there are 14, not the 13 the plan assumed (the plan
 * missed `claude-settings` alongside `cline-settings`).
 */
const CLI_TOOLS_SETTINGS = [
  "opencode-settings",
  "claude-settings",
  "cline-settings",
  "openclaw-settings",
  "kilo-settings",
  "copilot-settings",
  "codex-settings",
  "jcode-settings",
  "cowork-settings",
  "devin-settings",
  "deepseek-tui-settings",
  "droid-settings",
  "hermes-settings",
  "grok-build-settings",
];

const ROUTE_FILES = [
  ...CLI_TOOLS_SETTINGS.map((name) => `src/app/api/cli-tools/${name}/route.js`),
  "src/app/api/cli-tools/antigravity-mitm/route.js",
  "src/app/api/oauth/cursor/auto-import/route.js",
  "src/app/api/tunnel/tailscale-check/route.js",
  "src/app/api/tunnel/tailscale-install/route.js",
  "src/app/api/version/shutdown/route.js",
  "src/app/api/version/update/route.js",
];

/** Depth-first walk over an ESTree subtree, skipping position metadata. */
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "parent") continue;
    walk(node[key], visit);
  }
}

function findCall(node, name) {
  let found = null;
  walk(node, (n) => {
    if (!found && n.type === "CallExpression" && n.callee?.type === "Identifier") {
      if (n.callee.name === name) found = n;
    }
  });
  return found;
}

function findNextResponseJson(node) {
  let found = null;
  walk(node, (n) => {
    if (found) return;
    if (n.type !== "CallExpression" || n.callee?.type !== "MemberExpression") return;
    const { object, property } = n.callee;
    if (object?.type === "Identifier" && object.name === "NextResponse" && property?.name === "json") {
      found = n;
    }
  });
  return found;
}

function hasNumericLiteral(node, value) {
  let found = false;
  walk(node, (n) => {
    if (n.type === "Literal" && n.value === value) found = true;
  });
  return found;
}

function hasUnauthorizedErrorBody(node) {
  let found = false;
  walk(node, (n) => {
    if (n.type !== "Property" || n.key?.name !== "error") return;
    if (n.value?.type === "Literal" && n.value.value === "Unauthorized") found = true;
  });
  return found;
}

function parseModule(source, label) {
  return espree.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    loc: true,
  });
}

function exportedHandlers(ast) {
  const out = [];
  for (const node of ast.body) {
    if (node.type !== "ExportNamedDeclaration" || !node.declaration) continue;
    const d = node.declaration;
    if (d.type !== "FunctionDeclaration" || !d.id) continue;
    if (HTTP_METHODS.includes(d.id.name)) out.push(d);
  }
  return out;
}

function importsRequireDashboardAuth(ast) {
  return ast.body.some(
    (n) =>
      n.type === "ImportDeclaration" &&
      n.source.value.endsWith("auth/routeAuth.js") &&
      n.specifiers.some(
        (s) => s.type === "ImportSpecifier" && s.imported?.name === "requireDashboardAuth",
      ),
  );
}

/**
 * Returns one string per violation. Empty array == route is gated correctly.
 */
function findAuthGateProblems(source, label = "<source>") {
  const problems = [];
  const ast = parseModule(source, label);

  if (!importsRequireDashboardAuth(ast)) {
    problems.push(`${label}: no import of requireDashboardAuth from an "@/lib/auth/routeAuth.js" path`);
  }

  const handlers = exportedHandlers(ast);
  if (handlers.length === 0) {
    problems.push(`${label}: no exported HTTP handler found (${HTTP_METHODS.join("/")})`);
    return problems;
  }

  for (const fn of handlers) {
    const where = `${label} ${fn.id.name}()`;
    const takesRequest = fn.params.some(
      (p) => p.type === "Identifier" && p.name === "request",
    );
    if (!takesRequest) {
      problems.push(`${where}: handler does not accept a \`request\` argument, so it cannot be guarded`);
    }

    const first = fn.body?.body?.[0];
    if (!first) {
      problems.push(`${where}: handler body is empty`);
      continue;
    }
    if (first.type !== "IfStatement") {
      problems.push(
        `${where} line ${first.loc.start.line}: first statement is ${first.type}, expected the auth guard IfStatement`,
      );
      continue;
    }

    const call = findCall(first.test, "requireDashboardAuth");
    if (!call) {
      problems.push(
        `${where} line ${first.loc.start.line}: first statement is an if, but its condition never calls requireDashboardAuth()`,
      );
      continue;
    }

    const json = findNextResponseJson(first.consequent);
    if (!json) {
      problems.push(`${where}: auth guard does not reject with NextResponse.json(...)`);
      continue;
    }
    if (!hasUnauthorizedErrorBody(json.arguments[0])) {
      problems.push(`${where}: 401 body is not { error: "Unauthorized" }`);
    }
    if (!hasNumericLiteral(json.arguments[1] ?? {}, 401)) {
      problems.push(`${where}: auth guard response status is not 401`);
    }
  }

  return problems;
}

describe("route auth gate", () => {
  it("covers the 20 route files this task owns", () => {
    expect(ROUTE_FILES).toHaveLength(20);
    for (const rel of ROUTE_FILES) {
      expect(fs.existsSync(path.resolve(rel)), `${rel} must exist`).toBe(true);
    }
  });

  it.each(ROUTE_FILES)("%s guards every exported handler as its first statement", (rel) => {
    const source = fs.readFileSync(path.resolve(rel), "utf8");
    expect(findAuthGateProblems(source, rel)).toEqual([]);
  });
});

/**
 * Self-check. Without these, a broken checker would happily go green forever.
 * Each fixture is a way the guard can be present in the file yet not gate the
 * handler — every one must be reported.
 */
describe("route auth gate: self-check that it is not a fake guard", () => {
  const IMPORTS = `import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
`;

  it("accepts the real shape: guard first, then the work", () => {
    const src = `${IMPORTS}
export async function POST(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  spawnUpdaterAndExit();
}`;
    expect(findAuthGateProblems(src, "fixture-ok")).toEqual([]);
  });

  it("rejects a guard moved AFTER an early return", () => {
    const src = `${IMPORTS}
export async function POST(request) {
  return NextResponse.json({ error: "Cowork is disabled" }, { status: 403 });
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  spawnUpdaterAndExit();
}`;
    const problems = findAuthGateProblems(src, "fixture-moved");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/first statement is ReturnStatement/);
  });

  it("rejects a guard that only exists in an unused module-level helper", () => {
    const src = `${IMPORTS}
async function authorized(request) {
  return requireDashboardAuth(request);
}
export async function GET(request) {
  const authed = await authorized(request);
  return NextResponse.json({ ok: authed });
}`;
    const problems = findAuthGateProblems(src, "fixture-helper");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /first statement is VariableDeclaration, expected the auth guard IfStatement/,
    );
  });

  it("rejects a first-statement `if` that gates on the wrapper, not the auth call", () => {
    const src = `${IMPORTS}
async function authorized(request) {
  return requireDashboardAuth(request);
}
export async function GET(request) {
  if (!await authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true });
}`;
    const problems = findAuthGateProblems(src, "fixture-wrapper-if");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/its condition never calls requireDashboardAuth/);
  });

  it("rejects a handler that never mentions the guard at all", () => {
    const src = `${IMPORTS}
export async function GET() {
  return NextResponse.json({ ok: true });
}`;
    const problems = findAuthGateProblems(src, "fixture-unguarded");
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/does not accept a `request` argument/);
    expect(problems[1]).toMatch(/expected the auth guard IfStatement/);
  });

  it("rejects a guard that downgrades the 401 to another status", () => {
    const src = `${IMPORTS}
export async function DELETE(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 200 });
  stopServer();
}`;
    const problems = findAuthGateProblems(src, "fixture-status");
    expect(problems).toEqual([
      "fixture-status DELETE(): auth guard response status is not 401",
    ]);
  });

  it("rejects a file with the import stripped out", () => {
    const src = `import { NextResponse } from "next/server";
export async function GET(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}`;
    const problems = findAuthGateProblems(src, "fixture-noimport");
    expect(problems).toEqual([
      "fixture-noimport: no import of requireDashboardAuth from an \"@/lib/auth/routeAuth.js\" path",
    ]);
  });
});

// A syntax-level gate cannot catch the inverse mistake: a guarded handler whose
// in-process caller invokes it without the `request` the guard dereferences.
// `all-statuses` aggregates 14 of the guarded GETs by importing them directly,
// so it is the single point where that mistake blanks the whole CLI Tools page.
describe("in-process callers forward `request` to guarded handlers", () => {
  const ROOT = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const ALL_STATUSES = path.join(ROOT, "src/app/api/cli-tools/all-statuses/route.js");

  it("all-statuses passes its own request into every status getter", () => {
    const src = fs.readFileSync(ALL_STATUSES, "utf8");

    // The guard's first act is `request.headers.get(...)`; an undefined request
    // throws a TypeError that all-statuses' own `catch {}` converts to `null`.
    const callSites = [...src.matchAll(/getter\s*\(/g)];
    expect(callSites.length).toBeGreaterThan(0);
    for (const call of callSites) {
      // Reject both `getter()` and any call that does not forward the request.
      expect(src.slice(call.index, call.index + 40)).toMatch(/getter\(\s*request\s*\)/);
    }

    // The handler must also accept the request Next.js hands it.
    expect(src).toMatch(/export\s+async\s+function\s+GET\s*\(\s*request\s*\)/);
  });
});
