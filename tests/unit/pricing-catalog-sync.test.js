import { describe, it, expect } from "vitest";
import { parseProviderPage, buildPricing } from "../../src/lib/pricingCatalog/sync.js";

// Row shape mirrored from the live models.dev provider pages (verified
// 2026-09): copy-source carries the model id, the price cell carries
// "$input / $output" per 1M tokens.
const ROW = (id, ctx, out, price) =>
  `<tr data-search="Some model description ${id} Lab lab"><td data-sort="Name"><a class="primary-link" href="/models/lab/${id}">Name</a><span class="subtle mono">lab/${id}</span></td>` +
  `<td class="mono" data-sort="${id}"><span class="copy-cell"><span class="copy-source">${id}</span><button>[SVG]</button></span></td>` +
  `<td data-sort="${ctx}">1,000,000</td><td data-sort="${out}">128,000</td>` +
  `<td data-sort="${price}">$${price} / $${price}</td>` +
  `<td data-sort="Yes">Yes</td></tr>`;

const PAGE = (rows) => `<html><table><tbody>${rows.join("")}</tbody></table></html>`;

describe("parseProviderPage", () => {
  it("extracts model id and input/output price from each row", () => {
    const html = PAGE([
      ROW("claude-opus-4-6", 1000000, 128000, "5.00"),
      ROW("claude-sonnet-4-6", 200000, 64000, "3.00"),
    ]);
    expect(parseProviderPage(html)).toEqual([
      { modelId: "claude-opus-4-6", input: 5, output: 5 },
      { modelId: "claude-sonnet-4-6", input: 3, output: 3 },
    ]);
  });

  it("skips rows without a price cell", () => {
    const noPrice = `<tr data-search="x"><td><a class="primary-link" href="/models/lab/m">m</a></td>` +
      `<td class="mono"><span class="copy-source">m</span></td>` +
      `<td data-sort="1000">1,000</td><td data-sort="-">-</td></tr>`;
    expect(parseProviderPage(PAGE([ROW("gpt-5", 1, 1, "1.25"), noPrice]))).toEqual([
      { modelId: "gpt-5", input: 1.25, output: 1.25 },
    ]);
  });

  it("returns an empty list for pages without table rows", () => {
    expect(parseProviderPage("<html><body>nothing</body></html>")).toEqual([]);
  });
});

describe("buildPricing", () => {
  it("derives claude cache rates from the published 0.1/1.25 ratios", () => {
    expect(buildPricing("claude", 5, 25)).toEqual({
      input: 5,
      output: 25,
      cached: 0.5,
      reasoning: 25,
      cache_creation: 6.25,
    });
  });

  it("derives deepseek cache rate at 2% of input", () => {
    const p = buildPricing("deepseek", 0.14, 0.28);
    expect(p.cached).toBeCloseTo(0.0028, 6);
    expect(p.cache_creation).toBeCloseTo(0.0028, 6);
  });

  it("falls back to 0.5 cache ratio for unknown families", () => {
    const p = buildPricing("unknown", 2, 8);
    expect(p.cached).toBe(1);
    expect(p.cache_creation).toBe(1);
  });
});
