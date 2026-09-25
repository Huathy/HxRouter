import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDashboardAuth: vi.fn(async () => true),
  verifyDashboardPassword: vi.fn(async () => true),
  listCheckinScripts: vi.fn(async () => []),
  createCheckinScript: vi.fn(),
  getCheckinScriptById: vi.fn(),
  updateCheckinScript: vi.fn(),
  deleteCheckinScript: vi.fn(),
  assertPublicUrl: vi.fn(async () => ({ url: new URL("https://example.com"), addresses: [] })),
}));

vi.mock("@/lib/auth/routeAuth.js", () => ({ requireDashboardAuth: mocks.requireDashboardAuth }));
vi.mock("@/lib/auth/dashboardSession.js", () => ({ verifyDashboardPassword: mocks.verifyDashboardPassword }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: mocks.assertPublicUrl }));
vi.mock("@/lib/db/index.js", () => ({
  listCheckinScripts: mocks.listCheckinScripts,
  createCheckinScript: mocks.createCheckinScript,
  getCheckinScriptById: mocks.getCheckinScriptById,
  updateCheckinScript: mocks.updateCheckinScript,
  deleteCheckinScript: mocks.deleteCheckinScript,
}));

const script = {
  id: "script-1",
  name: "Example",
  enabled: false,
  scheduleType: "manual",
  cronExpr: "",
  timezone: "UTC",
  nextRunAt: null,
  lastRunAt: null,
  config: { url: "https://example.com/check-in", method: "POST", headers: {}, body: "REALBODY", expectedStatus: [200] },
  secretCiphertext: "v1.secret.ciphertext",
};

beforeEach(() => {
  process.env.AUTOMATION_SECRET_KEY = randomBytes(32).toString("base64");
  vi.clearAllMocks();
  mocks.requireDashboardAuth.mockResolvedValue(true);
  mocks.verifyDashboardPassword.mockResolvedValue(true);
  mocks.createCheckinScript.mockResolvedValue({ ...script, secretCiphertext: "v1.new.ciphertext" });
  mocks.getCheckinScriptById.mockResolvedValue(script);
  mocks.updateCheckinScript.mockResolvedValue({ ...script, name: "Updated" });
  mocks.deleteCheckinScript.mockResolvedValue(script);
  mocks.assertPublicUrl.mockResolvedValue({ url: new URL("https://example.com"), addresses: [] });
});

describe("check-in script API", () => {
  it("does not return secret ciphertext in list DTOs", async () => {
    mocks.listCheckinScripts.mockResolvedValue([script]);
    const { GET } = await import("../../src/app/api/checkin-scripts/route.js");
    const response = await GET(new Request("http://localhost/api/checkin-scripts"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.scripts[0].hasSecret).toBe(true);
    expect(payload.scripts[0].secretCiphertext).toBeUndefined();
    expect(payload.scripts[0].config.body).toBe("");
    expect(payload.scripts[0].config.bodyOmitted).toBe(true);
  });

  it("requires the operation password for writes", async () => {
    mocks.verifyDashboardPassword.mockResolvedValue(false);
    const { POST } = await import("../../src/app/api/checkin-scripts/route.js");
    const response = await POST(new Request("http://localhost/api/checkin-scripts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(401);
    expect(mocks.createCheckinScript).not.toHaveBeenCalled();
  });

  it("preserves an omitted request body when toggling a script", async () => {
    const { PUT } = await import("../../src/app/api/checkin-scripts/[id]/route.js");
    const response = await PUT(new Request("http://localhost/api/checkin-scripts/script-1", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-9r-password": "correct" },
      body: JSON.stringify({
        name: "Example",
        enabled: false,
        scheduleType: "manual",
        timezone: "UTC",
        config: {
          url: "https://example.com/check-in",
          method: "POST",
          headers: {},
          body: "",
          bodyOmitted: true,
          expectedStatus: [200],
        },
        secretAction: "keep",
      }),
    }), { params: Promise.resolve({ id: "script-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.updateCheckinScript).toHaveBeenCalledWith("script-1", expect.objectContaining({
      config: expect.objectContaining({ body: "REALBODY" }),
    }));
  });

  it("stores a new secret through the encryption helper", async () => {
    const { POST } = await import("../../src/app/api/checkin-scripts/route.js");
    const response = await POST(new Request("http://localhost/api/checkin-scripts", {
      method: "POST",
      headers: { "content-type": "application/json", "x-9r-password": "correct" },
      body: JSON.stringify({
        name: "Example",
        enabled: false,
        scheduleType: "manual",
        timezone: "UTC",
        config: { url: "https://example.com/check-in", method: "POST", headers: { Authorization: "Bearer {{secret}}" } },
        secret: "token",
        secretAction: "replace",
      }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(mocks.createCheckinScript).toHaveBeenCalledWith(expect.objectContaining({ secretCiphertext: expect.stringMatching(/^v1\./) }));
    expect(payload.script.secretCiphertext).toBeUndefined();
  });
});
