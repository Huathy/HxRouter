import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Groups unhandled errors by source file and prints them before the summary,
    // so a leaked in-flight request cannot hide behind unrelated red files.
    reporters: ["default", "./tests/unhandled-error-reporter.js"],
    // Don't scan nested agent/git worktrees — they carry their own copies of
    // tests but lack the root dependency context.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/.kilo/**", "**/.git/**", "**/dist/**", "**/all-endpoints-robust.test.js"],
    maxConcurrency: 10,
    // Several suites do heavy one-off work in hooks/imports: eslint config
    // loading (~11s), xAI PKCE + endpoint discovery (9s), and provider module
    // graphs re-imported after `vi.resetModules()`. The observed slowest
    // undeclared case is ~11s, so these bounds carry 2-3x headroom for
    // contention spikes while staying a hard ceiling. Genuinely long work
    // (e.g. the eslint react-hooks guard) declares its own per-test timeout.
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: "threads",
    // Suppress noisy console output from handlers under test
    silent: false,
    env: {
      API_KEY_SECRET: "test-api-key-secret-for-ci-only",
    },
  },
  // Next.js compiles JSX inside plain `.js` files; Vite/esbuild does not, so
  // importing any component from a test failed in `vite:import-analysis` with
  // "content contains invalid JS syntax". Without this, every React component in
  // the repo was untestable and tests could only read source as text — which is
  // a fake guard, since breaking the JSX does not turn a string match red.
  esbuild: {
    // "automatic" injects the jsx-runtime import, matching Next's own default.
    // Plain "transform" would require every component to `import React`, and
    // none of them do.
    jsx: "automatic",
    loader: "jsx",
    include: [/\.jsx?$/],
    exclude: [],
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
