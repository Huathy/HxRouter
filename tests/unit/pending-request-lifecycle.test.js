import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finishPendingRequest, trackPendingRequest, PENDING_TIMEOUT_MS } from "../../src/lib/db/repos/usageRepo.js";

function clearPendingState() {
  for (const timer of Object.values(global._pendingTimers || {})) clearTimeout(timer);
  for (const key of Object.keys(global._pendingTimers || {})) delete global._pendingTimers[key];
  for (const key of Object.keys(global._pendingRequests?.byModel || {})) delete global._pendingRequests.byModel[key];
  for (const key of Object.keys(global._pendingRequests?.byAccount || {})) delete global._pendingRequests.byAccount[key];
  for (const key of Object.keys(global._pendingRequests?.byId || {})) delete global._pendingRequests.byId[key];
  for (const key of Object.keys(global._legacyPendingIds || {})) delete global._legacyPendingIds[key];
}

describe("pending request lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPendingState();
  });

  afterEach(() => {
    clearPendingState();
    vi.useRealTimers();
  });

  it("settles concurrent requests independently for the same account and model", () => {
    const firstId = trackPendingRequest("gpt-4", "openai", "c1", true);
    const secondId = trackPendingRequest("gpt-4", "openai", "c1", true);

    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(2);
    expect(global._pendingRequests.byAccount.c1["gpt-4 (openai)"]).toBe(2);

    expect(finishPendingRequest(firstId)).toBe(true);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(1);
    expect(global._pendingRequests.byAccount.c1["gpt-4 (openai)"]).toBe(1);

    expect(finishPendingRequest(firstId)).toBe(false);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(1);

    expect(finishPendingRequest(secondId)).toBe(true);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBeUndefined();
    expect(global._pendingRequests.byAccount.c1).toBeUndefined();
  });

  it("keeps legacy completion scoped to the original account", () => {
    trackPendingRequest("gpt-4", "openai", "c1", true);
    trackPendingRequest("gpt-4", "openai", "c2", true);
    trackPendingRequest("gpt-4", "openai", "c2", false);
    expect(global._pendingRequests.byAccount.c1["gpt-4 (openai)"]).toBe(1);
    expect(global._pendingRequests.byAccount.c2).toBeUndefined();
  });

  it("expires only the request whose watchdog elapsed", () => {
    const firstId = trackPendingRequest("gpt-4", "openai", "c1", true);
    vi.advanceTimersByTime(1000);
    const secondId = trackPendingRequest("gpt-4", "openai", "c1", true);

    vi.advanceTimersByTime(PENDING_TIMEOUT_MS - 1000);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBeUndefined();
    expect(finishPendingRequest(secondId)).toBe(false);
    expect(finishPendingRequest(firstId)).toBe(false);
  });
});
