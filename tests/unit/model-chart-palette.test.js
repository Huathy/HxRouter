import { describe, expect, it } from "vitest";
import { DELETED_MODEL_COLOR, assignModelColors, assignStableModelColors, getVividModelColor } from "../../src/app/(dashboard)/dashboard/usage/components/modelChartPalette.js";

describe("model chart palette", () => {
  it("uses red, orange, yellow, green, cyan, blue, then purple", () => {
    const keys = Array.from({ length: 7 }, (_, index) => `model-${index + 1}`);
    const colors = assignModelColors(keys, new Map(), new Set());

    expect([...colors.values()].map((entry) => entry.color)).toEqual([
      "hsl(0 88% 58%)",
      "hsl(30 88% 58%)",
      "hsl(60 88% 58%)",
      "hsl(150 88% 58%)",
      "hsl(180 88% 58%)",
      "hsl(215 88% 58%)",
      "hsl(270 88% 58%)",
    ]);
  });

  it("cycles into vivid variants after the seven primary colors", () => {
    const keys = Array.from({ length: 8 }, (_, index) => `model-${index + 1}`);
    const colors = assignModelColors(keys, new Map(), new Set());

    expect(colors.get("model-8").color).toBe("hsl(348 94% 64%)");
  });

  it("keeps colors stable through the component helper", () => {
    const first = assignStableModelColors(["stable-b", "stable-a"]);
    const second = assignStableModelColors(["stable-a", "stable-b", "stable-c"]);
    expect(second.get("stable-a").color).toBe(first.get("stable-a").color);
    expect(second.get("stable-b").color).toBe(first.get("stable-b").color);
  });

  it("provides distinct variants before cycling the palette", () => {
    const colors = new Set(Array.from({ length: 84 }, (_, index) => getVividModelColor(index)));
    expect(colors.size).toBe(84);
  });

  it("keeps existing model colors stable when a new model appears", () => {
    const first = assignModelColors(["beta", "gamma"], new Map(), new Set());
    const previousAssignments = new Map([...first].map(([key, entry]) => [key, entry.index]));
    const second = assignModelColors(["alpha", "beta", "gamma"], previousAssignments, new Set());

    expect(second.get("beta").color).toBe(first.get("beta").color);
    expect(second.get("gamma").color).toBe(first.get("gamma").color);
    expect(second.get("alpha").color).toBe("hsl(60 88% 58%)");
  });

  it("uses gray only for explicitly deleted or disabled models", () => {
    const colors = assignModelColors(["active", "deleted"], new Map(), new Set(["deleted"]));

    expect(colors.get("active").color).toBe("hsl(0 88% 58%)");
    expect(colors.get("deleted").color).toBe(DELETED_MODEL_COLOR);
  });
});
