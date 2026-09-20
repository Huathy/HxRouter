// Verify the dashboard provider-level enable/disable switch is enforced at
// credential selection. No-auth free providers (opencode, mimo-free, ...) have
// no connection row, so the gate must run before the virtual-connection
// injection and before any DB lookup.
import { describe, it, expect, vi, beforeEach } from "vitest";

const getProviderConnections = vi.fn();
const updateProviderConnection = vi.fn();
const getSettings = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getProviderConnections,
  updateProviderConnection,
  validateApiKey: vi.fn(),
  getSettings,
  getProviderNodeById: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(() => null),
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

describe("provider-level disabled gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettings.mockResolvedValue({});
    getProviderConnections.mockResolvedValue([]);
  });

  it("returns null for a disabled no-auth provider without touching connections", async () => {
    getSettings.mockResolvedValue({ disabledProviders: ["opencode"] });

    const result = await getProviderCredentials("opencode", null, "muse-spark-1.2-contributor-free");

    expect(result).toBeNull();
    expect(getProviderConnections).not.toHaveBeenCalled();
  });

  it("resolves an alias to its canonical id before checking the disabled list", async () => {
    getSettings.mockResolvedValue({ disabledProviders: ["mimo-free"] });

    const result = await getProviderCredentials("mmf", null, "mimo-auto");

    expect(result).toBeNull();
    expect(getProviderConnections).not.toHaveBeenCalled();
  });

  it("still injects the virtual connection for an enabled no-auth provider", async () => {
    getSettings.mockResolvedValue({ disabledProviders: [] });

    const result = await getProviderCredentials("opencode", null, "muse-spark-1.2-contributor-free");

    expect(result).toMatchObject({ id: "noauth", isActive: true });
    expect(getProviderConnections).not.toHaveBeenCalled();
  });

  it("blocks a credentialed provider and skips the DB lookup", async () => {
    getSettings.mockResolvedValue({ disabledProviders: ["openai"] });

    const result = await getProviderCredentials("openai", null, "gpt-4o");

    expect(result).toBeNull();
    expect(getProviderConnections).not.toHaveBeenCalled();
  });
});
