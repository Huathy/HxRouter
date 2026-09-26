import { describe, it, expect } from "vitest";
import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Modal, { ConfirmModal } from "@/shared/components/Modal";
import Drawer from "@/shared/components/Drawer";

/** Repo root, for the source-level invariants asserted at the bottom of this file. */
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Dialog-semantics regression guard (T-5).
 *
 * The assertions below read *rendered markup*, never the component source, so
 * deleting `role="dialog"` from the JSX actually fails this file.
 *
 * Scope: Modal.js / Drawer.js only. Components that hand-roll their own overlay
 * (PricingModal, ChangelogModal, DonateModal, LanguageSwitcher, Sidebar,
 * ProviderLimits, MitmServerCard, providers/page.js, ...) are known debt and
 * are deliberately not covered here.
 *
 * Focus trapping, initial focus and focus restoration live in `useEffect`,
 * which `renderToStaticMarkup` never runs. Verifying those needs a live DOM
 * (jsdom/happy-dom), which this repo does not depend on, so it is out of
 * scope for this file rather than faked. The loader gap that once forced this
 * file to bundle components by hand is closed by
 * `esbuild: { jsx: "automatic", loader: "jsx" }` in tests/vitest.config.js, and
 * is itself guarded by tests/unit/jsx-transform-guard.test.js.
 */

const noop = () => {};

/** Render `Modal` with sensible open-state defaults. */
const renderModal = (props) =>
  renderToStaticMarkup(
    h(Modal, { isOpen: true, onClose: noop, title: "Edit Connection", ...props }, h("p", null, "body"))
  );

/** Render `Drawer` with sensible open-state defaults. */
const renderDrawer = (props) =>
  renderToStaticMarkup(
    h(Drawer, { isOpen: true, onClose: noop, title: "Request Details", ...props }, h("p", null, "body"))
  );

/** Pull the value of `attr` off the first tag in `html` that carries it. */
function attrOf(html, attr) {
  const match = new RegExp(`\\b${attr}="([^"]*)"`).exec(html);
  return match ? match[1] : null;
}

/** Pull the `id` off the first <h2> in `html`, or null when there is none. */
function h2Id(html) {
  const match = /<h2\b[^>]*\bid="([^"]*)"/.exec(html);
  return match ? match[1] : null;
}

/** Open the tag that carries `role="dialog"`. */
function panelTag(html) {
  const match = /<div\b[^>]*\brole="dialog"[^>]*>/.exec(html);
  expect(match, `no element with role="dialog" in:\n${html}`).not.toBeNull();
  return match[0];
}

describe("Modal dialog semantics", () => {
  it("exposes role=dialog and aria-modal on the panel container", () => {
    const html = renderModal();

    expect(panelTag(html)).toContain('aria-modal="true"');
  });

  it("leaves the overlay aria-hidden and free of dialog semantics", () => {
    const html = renderModal();

    const overlay = /<div\b[^>]*aria-hidden="true"[^>]*>/.exec(html);
    expect(overlay, `no aria-hidden overlay in:\n${html}`).not.toBeNull();
    expect(overlay[0]).not.toContain('role="dialog"');
    expect(overlay[0]).not.toContain('aria-modal=');
  });

  it("points aria-labelledby at the id actually rendered on the <h2>", () => {
    const html = renderModal();

    const labelledBy = attrOf(html, "aria-labelledby");
    const headingId = h2Id(html);

    expect(labelledBy, `no aria-labelledby in:\n${html}`).not.toBeNull();
    expect(headingId, `no <h2 id> in:\n${html}`).not.toBeNull();
    expect(labelledBy).toBe(headingId);
  });

  it("uses a selector-safe id so aria-labelledby can be queried directly", () => {
    // React 19 useId emits ids like `_R_0_` -- a valid CSS ident, so
    // `querySelector("#" + id)` and `getElementById` both work.
    expect(attrOf(renderModal(), "aria-labelledby")).toMatch(/^[A-Za-z_][\w.-]*$/);
  });

  it("makes the panel programmatically focusable for the no-focusable fallback", () => {
    expect(panelTag(renderModal())).toContain('tabindex="-1"');
  });

  it("omits aria-labelledby when no title prop was passed", () => {
    const html = renderModal({ title: undefined });

    expect(panelTag(html)).toBeTruthy();
    expect(html).not.toContain("aria-labelledby");
    expect(html).not.toMatch(/<h2\b/);
  });

  it("renders nothing when closed", () => {
    expect(renderToStaticMarkup(h(Modal, { isOpen: false, onClose: noop, title: "Nope" }))).toBe("");
  });

  it("carries dialog semantics through the ConfirmModal wrapper", () => {
    const html = renderToStaticMarkup(
      h(ConfirmModal, {
        isOpen: true,
        onClose: noop,
        onConfirm: noop,
        title: "Close Proxy",
        message: "Really?",
      })
    );

    expect(panelTag(html)).toContain('aria-modal="true"');
    expect(attrOf(html, "aria-labelledby")).toBe(h2Id(html));
  });

  it("keeps sibling instances in one tree from colliding on the title id", () => {
    // useId is unique per render root, so both modals must be rendered
    // together -- two separate renderToStaticMarkup calls both start at _R_0_.
    const html = renderToStaticMarkup(
      h(
        Fragment,
        null,
        h(Modal, { isOpen: true, onClose: noop, title: "A" }, h("p", null, "a")),
        h(Modal, { isOpen: true, onClose: noop, title: "B" }, h("p", null, "b"))
      )
    );

    const headingIds = [...html.matchAll(/<h2\b[^>]*\bid="([^"]*)"/g)].map((m) => m[1]);
    const labelledBys = [...html.matchAll(/aria-labelledby="([^"]*)"/g)].map((m) => m[1]);

    expect(headingIds).toHaveLength(2);
    expect(new Set(headingIds).size).toBe(2);
    expect(labelledBys).toEqual(headingIds);
  });

  it("keeps the pre-existing close controls and overlay click target", () => {
    const html = renderModal();

    expect(html).toContain('aria-label="Close"');
    expect((html.match(/aria-label="Close"/g) || []).length).toBe(2); // traffic light + mobile X
  });
});

describe("Drawer dialog semantics", () => {
  it("exposes role=dialog and aria-modal on the panel container", () => {
    expect(panelTag(renderDrawer())).toContain('aria-modal="true"');
  });

  it("leaves the overlay aria-hidden and free of dialog semantics", () => {
    const overlay = /<div\b[^>]*aria-hidden="true"[^>]*>/.exec(renderDrawer());

    expect(overlay, "no aria-hidden overlay").not.toBeNull();
    expect(overlay[0]).not.toContain('role="dialog"');
    expect(overlay[0]).not.toContain('aria-modal=');
  });

  it("points aria-labelledby at the id actually rendered on the <h2>", () => {
    const html = renderDrawer();

    expect(attrOf(html, "aria-labelledby")).toBe(h2Id(html));
    expect(h2Id(html)).toBeTruthy();
  });

  it("makes the panel programmatically focusable for the no-focusable fallback", () => {
    expect(panelTag(renderDrawer())).toContain('tabindex="-1"');
  });

  it("omits aria-labelledby when no title prop was passed", () => {
    const html = renderDrawer({ title: undefined });

    expect(panelTag(html)).toBeTruthy();
    expect(html).not.toContain("aria-labelledby");
    expect(html).not.toMatch(/<h2\b/);
  });

  it("renders nothing when closed", () => {
    expect(renderToStaticMarkup(h(Drawer, { isOpen: false, onClose: noop, title: "Nope" }))).toBe("");
  });

  it("keeps its close control and honours the className passthrough", () => {
    const html = renderDrawer({ className: "custom-panel" });

    expect(panelTag(html)).toContain("custom-panel");
    expect(html).toContain("slide-in-right");
  });
});

// The focus trap, initial focus and focus restore used to be duplicated
// byte-for-byte in Modal.js and Drawer.js. Divergence there is user visible ¡ª
// one component focus-traps users while the other drops focus on close ¡ª so the
// single-source invariant is pinned here. Behaviour itself still needs a live DOM
// (see the file header); this asserts the SHAPE that keeps the two in lockstep.
describe("focus trap has a single source", () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  it("both components delegate to the shared hook", () => {
    for (const rel of ["src/shared/components/Modal.js", "src/shared/components/Drawer.js"]) {
      const src = read(rel);
      expect(src, rel).toMatch(/useDialogFocusTrap\(\s*\{\s*isOpen\s*,\s*panelRef\s*\}\s*\)/);
    }
  });

  it("neither component reimplements the focusable query or the visibility probe", () => {
    for (const rel of ["src/shared/components/Modal.js", "src/shared/components/Drawer.js"]) {
      const src = read(rel);
      expect(src, `${rel} must not re-declare FOCUSABLE_SELECTOR`).not.toMatch(/FOCUSABLE_SELECTOR/);
      expect(src, `${rel} must not re-declare getFocusable/collectFocusable`).not.toMatch(/function\s+(getFocusable|collectFocusable)\b/);
      expect(src, `${rel} must not re-declare the offsetWidth visibility probe`).not.toMatch(/offsetWidth/);
    }
  });

  it("neither component re-implements the Tab handler inline", () => {
    for (const rel of ["src/shared/components/Modal.js", "src/shared/components/Drawer.js"]) {
      const src = read(rel);
      expect(src, `${rel} must not own a keydown Tab trap`).not.toMatch(/addEventListener\(\s*"keydown"\s*,\s*handleTab/);
    }
  });

  it("the shared hook collects the focusable list once per open, not per keypress", () => {
    const src = read("src/shared/hooks/useDialogFocusTrap.js");
    const collections = src.match(/collectFocusable\(/g) || [];
    // One definition + one call site inside the effect. A second call inside
    // handleTab would restore the per-keypress full-subtree query plus the
    // forced synchronous layout reads that made long dialogs janky.
    expect(collections).toHaveLength(2);
    const tabHandler = src.slice(src.indexOf("const handleTab"), src.indexOf("document.addEventListener"));
    expect(tabHandler).not.toMatch(/collectFocusable\(/);
  });
});
