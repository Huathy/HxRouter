import {
  claimDueCheckinScript,
  listDueCheckinScripts,
  markInterruptedCheckinRuns,
  updateCheckinScript,
} from "@/lib/db/index.js";
import { getNextCheckinRun } from "./cron.js";
import { executeCheckinRun } from "./runner.js";

const processStartedAt = Date.now();
const state = global.__checkinSchedulerState ??= {
  interval: null,
  startingPromise: null,
  generation: 0,
  ticking: false,
  activeRunIds: new Set(),
};

export async function tickCheckinScheduler({ now = Date.now() } = {}) {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const due = await listDueCheckinScripts(now, 20);
    for (const script of due) {
      if (state.activeRunIds.size >= 2) break;
      let nextRunAt;
      try {
        nextRunAt = getNextCheckinRun(script.cronExpr, script.timezone, now);
      } catch {
        await updateCheckinScript(script.id, { enabled: false, nextRunAt: null });
        continue;
      }
      const claimed = await claimDueCheckinScript(script.id, script.nextRunAt, nextRunAt);
      if (!claimed) continue;
      state.activeRunIds.add(claimed.run.id);
      void executeCheckinRun(claimed.script, claimed.run)
        .catch((error) => console.error(`[Checkin] run ${claimed.run.id} failed:`, error?.message || error))
        .finally(() => state.activeRunIds.delete(claimed.run.id));
    }
  } finally {
    state.ticking = false;
  }
}

export function startCheckinScheduler({ pollIntervalMs = 30000 } = {}) {
  if (state.interval) return state.startingPromise;
  if (state.startingPromise) return state.startingPromise;
  const generation = state.generation;
  const startingPromise = (async () => {
    await markInterruptedCheckinRuns(processStartedAt).catch((error) => console.error("[Checkin] startup recovery failed:", error?.message || error));
    if (state.generation !== generation) return;
    void tickCheckinScheduler().catch((error) => console.error("[Checkin] scheduler tick failed:", error?.message || error));
    state.interval = setInterval(() => {
      void tickCheckinScheduler().catch((error) => console.error("[Checkin] scheduler tick failed:", error?.message || error));
    }, Math.max(5000, Number(pollIntervalMs) || 30000));
    state.interval.unref?.();
  })();
  state.startingPromise = startingPromise;
  void startingPromise.finally(() => {
    if (state.startingPromise === startingPromise) state.startingPromise = null;
  });
  return startingPromise;
}

export function stopCheckinScheduler() {
  state.generation += 1;
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
  state.startingPromise = null;
}

