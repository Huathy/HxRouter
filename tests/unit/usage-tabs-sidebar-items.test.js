// T-6: the usage tabs and the sidebar nav groups must actually contain the
// entries their routes exist for.
//
// Both lists were only assertable after they moved out of JSX components into
// plain modules (`usage/tabs.js`, `sidebarItems.js`) — the vitest node
// environment cannot import a `.js` file containing JSX. While the usage tab
// options were an inline array literal inside `UsageContent`, "logs" rendered on
// the page and passed the ?tab= validator but was unreachable from the UI.
// Asserting the lists is what keeps that class of dead entry from returning.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { USAGE_TABS, USAGE_TAB_VALUES } from "@/app/(dashboard)/dashboard/usage/tabs.js";
import { debugItems, navItems, systemItems } from "@/shared/components/sidebarItems.js";

const DASHBOARD_DIR = path.resolve("src/app/(dashboard)/dashboard");

/** A sidebar href is only real if the App Router page behind it exists. */
function routeExists(href) {
  const rel = href.replace(/^\/dashboard\/?/, "");
  if (!rel) return fs.existsSync(path.join(DASHBOARD_DIR, "page.js"));
  const base = path.join(DASHBOARD_DIR, ...rel.split("/"));
  return fs.existsSync(path.join(base, "page.js"));
}

describe("usage page tabs", () => {
  it("exposes the logs tab, not just overview and details", () => {
    expect(USAGE_TAB_VALUES).toContain("logs");
  });

  it("keeps every tab that has a render branch selectable", () => {
    // The page renders RequestLogger for "logs" and RequestDetailsTab for
    // "details"; a tab that renders but is not listed here is unreachable.
    expect(USAGE_TAB_VALUES).toEqual(
      expect.arrayContaining(["overview", "logs", "details"]),
    );
  });

  it("has no duplicate tab values", () => {
    expect(new Set(USAGE_TAB_VALUES).size).toBe(USAGE_TAB_VALUES.length);
  });

  it("gives every tab a non-empty label", () => {
    for (const tab of USAGE_TABS) {
      expect(typeof tab.label).toBe("string");
      expect(tab.label.length).toBeGreaterThan(0);
    }
  });
});

describe("sidebar nav groups", () => {
  it("lists the mitm and pxpipe tools in the debug group", () => {
    const hrefs = debugItems.map((item) => item.href);
    expect(hrefs).toContain("/dashboard/mitm");
    expect(hrefs).toContain("/dashboard/pxpipe");
  });

  it("keeps the pre-existing debug entries", () => {
    const hrefs = debugItems.map((item) => item.href);
    expect(hrefs).toEqual(
      expect.arrayContaining(["/dashboard/console-log", "/dashboard/translator"]),
    );
  });

  it("has no duplicate hrefs within a group", () => {
    for (const [name, items] of Object.entries({ navItems, debugItems, systemItems })) {
      const hrefs = items.map((item) => item.href);
      expect(new Set(hrefs).size, `${name} has duplicate hrefs`).toBe(hrefs.length);
    }
  });

  it("points every entry at a route that exists", () => {
    const dead = [...navItems, ...debugItems, ...systemItems]
      .map((item) => item.href)
      .filter((href) => !routeExists(href));
    expect(dead).toEqual([]);
  });
});
