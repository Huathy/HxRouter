// Regression guard for the JSX transform in tests/vitest.config.js.
//
// Next.js compiles JSX inside plain `.js` files. Vite/esbuild does not, so
// before the `esbuild: { jsx: "automatic", loader: "jsx" }` entry, importing any
// component from a test died in `vite:import-analysis` with "content contains
// invalid JS syntax". That is invisible until someone writes a component test,
// and it pushes people toward reading source files as text — which is a fake
// guard, because corrupting the JSX does not turn a string match red.
//
// If this file fails to even collect, the loader is gone. It deliberately asserts
// the rendered markup, not the source, so a broken component is caught too.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Modal from "@/shared/components/Modal";
import Drawer from "@/shared/components/Drawer";
import { debugItems, navItems } from "@/shared/components/sidebarItems";
import { USAGE_TABS } from "@/app/(dashboard)/dashboard/usage/tabs";

describe("jsx transform availability", () => {
  it("renders a .js component that never imports React itself", () => {
    const html = renderToStaticMarkup(
      createElement(Modal, { isOpen: true, title: "Probe" }, null),
    );
    expect(html).toContain("Probe");
  });

  it("renders a second client component", () => {
    const html = renderToStaticMarkup(
      createElement(Drawer, { isOpen: true, title: "DrawerProbe" }, null),
    );
    expect(html).toContain("DrawerProbe");
  });

  it("still exposes the plain module exports the nav/tab tests rely on", () => {
    expect(Array.isArray(debugItems)).toBe(true);
    expect(Array.isArray(navItems)).toBe(true);
    expect(Array.isArray(USAGE_TABS)).toBe(true);
  });
});
