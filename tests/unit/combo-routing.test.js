import { describe, it, expect, beforeEach } from "vitest";

import { getRotatedModels, resetComboRotation } from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });

  it("weights bias round-robin selection over a full cycle (3:1)", () => {
    const models = ["provider/model-a", "provider/model-b"];
    const weights = { "provider/model-a": 3, "provider/model-b": 1 };

    resetComboRotation();
    const picks = Array.from({ length: 4 }, () =>
      getRotatedModels(models, "wcombo", "round-robin", 1, weights)[0]
    );
    const aCount = picks.filter((m) => m === "provider/model-a").length;
    const bCount = picks.filter((m) => m === "provider/model-b").length;
    expect(aCount).toBe(3);
    expect(bCount).toBe(1);
  });

  it("missing/invalid weights default to 1 (equal weighting)", () => {
    const models = ["provider/model-a", "provider/model-b"];

    resetComboRotation();
    const picks = Array.from({ length: 4 }, () =>
      getRotatedModels(models, "defw", "round-robin", 1, {})[0]
    );
    expect(picks).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("weights ignored for fallback strategy", () => {
    const models = ["provider/model-a", "provider/model-b"];
    const weights = { "provider/model-a": 3, "provider/model-b": 1 };

    resetComboRotation();
    expect(getRotatedModels(models, "fbw", "fallback", 1, weights)).toEqual(models);
  });
});
