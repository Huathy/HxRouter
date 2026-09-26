// Line-level diff between the client request and the translated provider request.
//
// The value here is showing *what translation actually did*: client format ->
// upstream format, plus any RTK / Caveman / Ponytail system-prompt injection.
//
// What this deliberately does NOT show: modality stripping and remote-image
// prefetch. `chatCore.js` rewrites the same body object before it is recorded on
// both sides (`record.request` and `providerRequest` read the same mutated
// body), so those changes cancel out in a diff. Surfacing them would need a new
// persisted field, which is out of scope here.
//
// Performance: a naive LCS over two JSON dumps is O(n·m) in cells. A request
// carrying 100 tool results serialises to 2,000-4,000 lines, which is 4M-16M
// cells — enough to drop frames on every panel open. So the diff is windowed
// around the first difference and gives up above a line budget, reporting
// "too large to diff" instead of hanging.

export const DIFF_WINDOW = 20;
export const DIFF_MAX_LINES = 400;
export const DIFF_MAX_CELLS = 200_000;

/**
 * @typedef {{ type: "equal" | "insert" | "delete", left: string|null, right: string|null, leftNo: number|null, rightNo: number|null }} DiffRow
 */

/** @returns {DiffRow[]} */
function rowsEqual(left, right) {
  return [{ type: "equal", left, right, leftNo: null, rightNo: null }];
}

/**
 * Classic LCS table diff, bounded by `maxCells`. Returns null when the inputs are
 * too large to diff exactly within the budget.
 */
function lcsRows(a, b, maxCells) {
  if (a.length * b.length > maxCells) return null;

  // table[i][j] = LCS length of a[i..] and b[j..]
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(rowsEqual(a[i], b[j])[0]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: "delete", left: a[i], right: null, leftNo: i + 1, rightNo: null });
      i++;
    } else {
      out.push({ type: "insert", left: null, right: b[j], leftNo: null, rightNo: j + 1 });
      j++;
    }
  }
  while (i < a.length) out.push({ type: "delete", left: a[i], right: null, leftNo: i + 1, rightNo: null }), i++;
  while (j < b.length) out.push({ type: "insert", left: null, right: b[j], leftNo: null, rightNo: j + 1 }), j++;
  return out;
}

/** Index of the first differing line, or -1. */
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function serialise(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Windowed line diff.
 *
 * @returns {{
 *   status: "identical" | "diffed" | "too-large",
 *   rows: DiffRow[],
 *   leftTotal: number, rightTotal: number,
 *   omittedBefore: number, omittedAfter: number,
 *   reason?: string
 * }}
 */
export function diffJsonLines(leftValue, rightValue) {
  const left = serialise(leftValue).split("\n");
  const right = serialise(rightValue).split("\n");

  const base = { leftTotal: left.length, rightTotal: right.length, rows: [], omittedBefore: 0, omittedAfter: 0 };

  const first = firstDifference(left, right);
  if (first === -1) return { ...base, status: "identical" };

  if (Math.max(left.length, right.length) > DIFF_MAX_LINES) {
    return {
      ...base,
      status: "too-large",
      reason: `Payload is ${Math.max(left.length, right.length)} lines; the line diff is capped at ${DIFF_MAX_LINES} to keep the panel responsive. Use the two JSON blocks below to compare manually.`,
    };
  }

  const start = Math.max(0, first - DIFF_WINDOW);
  const endFirst = Math.min(left.length, first + DIFF_WINDOW + 1);
  const endSecond = Math.min(right.length, first + DIFF_WINDOW + 1);
  const leftSlice = left.slice(start, endFirst);
  const rightSlice = right.slice(start, endSecond);

  const rows = lcsRows(leftSlice, rightSlice, DIFF_MAX_CELLS);
  if (!rows) {
    return {
      ...base,
      status: "too-large",
      reason: `Diff would need ${leftSlice.length * rightSlice.length} cells, over the ${DIFF_MAX_CELLS} budget.`,
    };
  }

  // Re-stamp real line numbers now that the window offset is known.
  let li = start;
  let ri = start;
  for (const row of rows) {
    if (row.type !== "insert") row.leftNo = ++li;
    if (row.type !== "delete") row.rightNo = ++ri;
  }

  const firstChanged = rows.findIndex((r) => r.type !== "equal");
  const lastChanged = rows.length - 1 - [...rows].reverse().findIndex((r) => r.type !== "equal");

  return {
    ...base,
    status: "diffed",
    rows: rows.slice(
      Math.max(0, firstChanged - 3),
      Math.min(rows.length, lastChanged + 4),
    ),
    omittedBefore: Math.max(0, firstChanged - 3),
    omittedAfter: Math.max(0, rows.length - lastChanged - 4),
  };
}
