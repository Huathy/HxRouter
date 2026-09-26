// T-4: the request diff pure function.
//
// Includes a hard performance assertion. The whole reason `diffJsonLines` is
// windowed and cell-budgeted is that a naive O(n·m) LCS over a 2,000-4,000 line
// JSON dump (100 tool results) blocks the main thread; a correctness-only test
// would happily pass while the panel hangs in production.
import { describe, it, expect } from "vitest";
import {
  diffJsonLines,
  DIFF_MAX_LINES,
} from "@/app/(dashboard)/dashboard/usage/components/requestDiff.js";

const left = { model: "gpt-4", messages: [{ role: "user", content: "hi" }] };
const right = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };

describe("diffJsonLines", () => {
  it("reports identical payloads without producing rows", () => {
    const result = diffJsonLines(left, left);
    expect(result.status).toBe("identical");
    expect(result.rows).toEqual([]);
  });

  it("marks a changed line as delete + insert", () => {
    const result = diffJsonLines(left, right);
    expect(result.status).toBe("diffed");
    const changed = result.rows.filter((r) => r.type !== "equal");
    expect(changed.map((r) => r.type).sort()).toEqual(["delete", "insert"]);
    expect(changed.find((r) => r.type === "delete").left).toContain('"hi"');
    expect(changed.find((r) => r.type === "insert").right).toContain('"hello"');
  });

  it("stamps real 1-based line numbers, not window-relative ones", () => {
    const result = diffJsonLines(
      { a: 1, b: 2, c: 3 },
      { a: 1, b: 99, c: 3 },
    );
    const insert = result.rows.find((r) => r.type === "insert");
    // The changed value sits on the 4th emitted line of the pretty JSON, not at
    // the start of the diff window.
    expect(insert.rightNo).toBeGreaterThan(1);
    expect(insert.leftNo).toBeNull();
  });

  it("surfaces an added key as an insert", () => {
    const result = diffJsonLines({ a: 1 }, { a: 1, b: 2 });
    expect(result.status).toBe("diffed");
    const inserts = result.rows.filter((r) => r.type === "insert");
    expect(inserts.some((r) => r.right.includes('"b"'))).toBe(true);
    // Not insert-only: JSON adds a trailing comma to the previous line, so that
    // line legitimately shows up as a delete+insert pair.
    expect(result.rows.filter((r) => r.type === "delete").length).toBeGreaterThan(0);
  });

  it("accepts a raw string on either side", () => {
    const result = diffJsonLines("a\nb\nc", "a\nB\nc");
    expect(result.status).toBe("diffed");
    expect(result.rows.some((r) => r.right === "B")).toBe(true);
  });

  it("does not throw on a circular structure", () => {
    const circular = { a: 1 };
    circular.self = circular;
    expect(() => diffJsonLines(circular, { a: 1 })).not.toThrow();
  });

  it("declines to diff a payload past the line cap and says why", () => {
    const big = { blob: Array.from({ length: DIFF_MAX_LINES + 50 }, (_, i) => `line ${i}`) };
    const result = diffJsonLines(big, { blob: ["different"] });
    expect(result.status).toBe("too-large");
    expect(result.reason).toMatch(/capped at/);
  });

  // The actual reason the windowing exists.
  it("diffs a 100-tool-result-sized payload well under 50ms", () => {
    const bigLeft = {
      messages: Array.from({ length: 100 }, (_, i) => ({
        role: "user",
        content: `tool result ${i}\n${"x".repeat(400)}`,
      })),
    };
    const bigRight = {
      messages: Array.from({ length: 100 }, (_, i) => ({
        role: "user",
        content: `tool result ${i} translated\n${"x".repeat(400)}`,
      })),
    };

    const start = performance.now();
    const result = diffJsonLines(bigLeft, bigRight);
    const elapsed = performance.now() - start;

    expect(result.status).toBe("too-large");
    expect(elapsed).toBeLessThan(50);
  });

  it("diffs a realistically sized request in well under 50ms", () => {
    const mediumLeft = { messages: Array.from({ length: 8 }, (_, i) => ({ role: "user", content: "line ".repeat(60) + i })) };
    const mediumRight = { messages: Array.from({ length: 8 }, (_, i) => ({ role: "user", content: "LINE ".repeat(60) + i })) };

    const start = performance.now();
    const result = diffJsonLines(mediumLeft, mediumRight);
    const elapsed = performance.now() - start;

    expect(result.status).toBe("diffed");
    expect(elapsed).toBeLessThan(50);
  });
});
