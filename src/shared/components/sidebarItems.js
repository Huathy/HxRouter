// Sidebar navigation groups.
//
// Kept in a JSX-free module so tests can assert the entry lists directly —
// `Sidebar.js` is a client component with JSX, which the vitest node environment
// cannot import. Same convention as `modelSelectUtils.js` and the ProviderLimits
// utils.
//
// Every route listed here must exist under src/app/(dashboard)/dashboard/. The
// `mitm` and `pxpipe` pages existed but were absent from this list, so they were
// only reachable by typing the URL.
export const navItems = [
  { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "api" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  // { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat" }, // Hidden
  { href: "/dashboard/combos", label: "Combos", icon: "layers" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/basic-chat", label: "Playground", icon: "sports_esports" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { href: "/dashboard/model-pricing", label: "Model Pricing", icon: "sell" },
  { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
];

export const debugItems = [
  { href: "/dashboard/console-log", label: "Console Log", icon: "terminal" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate" },
  { href: "/dashboard/mitm", label: "MITM Proxy", icon: "travel_explore" },
  { href: "/dashboard/pxpipe", label: "PXPipe", icon: "pipe" },
];

export const systemItems = [
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
  { href: "/dashboard/proxy-fitness", label: "Proxy Fitness", icon: "network_check" },
  { href: "/dashboard/checkin-scripts", label: "Check-in Scripts", icon: "event_available" },
  { href: "/dashboard/skills", label: "Skills", icon: "extension" },
];
