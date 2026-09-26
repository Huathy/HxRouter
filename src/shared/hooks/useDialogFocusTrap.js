"use client";

import { useEffect } from "react";

/**
 * Dialog focus management, shared by Modal and Drawer.
 *
 * This block used to be duplicated byte-for-byte in both components. That is a
 * drift hazard rather than a style issue: the trap, the initial-focus rule and
 * the focus-restore rule must behave identically across every dialog in the app,
 * and an a11y fix applied to only one copy leaves the other component either
 * focus-trapping users or dropping focus on close. Both components back a long
 * list of dialogs (ModelSelectModal, McpMarketplaceModal, EditConnectionModal,
 * RequestDetailsTab's Drawer, every ConfirmModal), so a divergence is user
 * visible, not theoretical.
 *
 * Behaviour:
 *  - On open, move focus into the panel unless a child already claimed it
 *    (an `autoFocus` input must not be yanked away).
 *  - Keep Tab / Shift+Tab cycling inside the panel. A stacked dialog owns focus,
 *    so only the topmost panel traps.
 *  - On close, hand focus back to whatever was focused before, if it still exists.
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function isVisible(el) {
  return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
}

function collectFocusable(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisible);
}

/**
 * @param {object} options
 * @param {boolean} options.isOpen
 * @param {import("react").RefObject<HTMLElement>} options.panelRef
 * @param {any} [options.refreshKey] - Bump to re-collect the focusable list when
 *   the panel's contents change shape (e.g. a list finished loading). Omit it
 *   for panels whose focusable set is fixed for the duration of one open.
 */
export function useDialogFocusTrap({ isOpen, panelRef, refreshKey }) {
  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    if (!panel) return;

    // Collected once per open, not per keypress. `isVisible` reads
    // offsetWidth/offsetHeight/getClientRects(), i.e. three forced synchronous
    // layouts PER MATCHED ELEMENT — doing that on every Tab inside a long list
    // dialog (McpMarketplaceModal and friends) made typing visibly janky.
    // The trade-off is a control that appears while the dialog is open is not in
    // the cycle until refreshKey changes; pass a key for those panels.
    const items = collectFocusable(panel);

    const previouslyFocused = document.activeElement;
    // Respect a child that already took focus (e.g. an `autoFocus` input)
    // instead of yanking it back to the first focusable.
    if (!panel.contains(previouslyFocused)) {
      (items[0] || panel).focus();
    }

    const handleTab = (e) => {
      if (e.key !== "Tab") return;
      const active = document.activeElement;
      // A stacked dialog owns focus; only the topmost panel traps.
      const owner = active?.closest?.('[role="dialog"]');
      if (owner && owner !== panel) return;

      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (!panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? lastItem : firstItem).focus();
      } else if (e.shiftKey && (active === firstItem || active === panel)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && active === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener("keydown", handleTab);
    return () => {
      document.removeEventListener("keydown", handleTab);
      if (
        previouslyFocused &&
        previouslyFocused !== document.body &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen, panelRef, refreshKey]);
}
