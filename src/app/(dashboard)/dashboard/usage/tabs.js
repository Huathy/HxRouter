// Tab definitions for /dashboard/usage.
//
// Kept in a JSX-free module so tests can assert the tab list directly — the page
// itself is a client component with JSX, which the vitest node environment cannot
// import. Same convention as `modelSelectUtils.js` and the ProviderLimits utils.
//
// "logs" renders a <RequestLogger /> and is accepted by the ?tab= validator, so
// it must stay in this list; an entry that renders but is not listed is
// unreachable from the UI.
export const USAGE_TABS = [
  { value: "overview", label: "Overview" },
  { value: "logs", label: "Logs" },
  { value: "details", label: "Details" },
];

export const USAGE_TAB_VALUES = USAGE_TABS.map((tab) => tab.value);

export const DEFAULT_USAGE_TAB = "overview";
