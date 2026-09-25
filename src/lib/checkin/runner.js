import { finishCheckinRun, markCheckinRunRunning } from "@/lib/db/index.js";
import { decryptCheckinSecret } from "./secretCrypto.js";
import { executeHttpCheckin, redactCheckinText } from "./httpCheckinExecutor.js";

function errorResult(code, message) {
  return { success: false, errorCode: code, errorMessage: message };
}

export async function executeCheckinRun(script, run, { fetchImpl } = {}) {
  const startedAt = Date.now();
  let result;
  let secret = "";
  try {
    await markCheckinRunRunning(run.id, startedAt);
    secret = script.secretCiphertext ? decryptCheckinSecret(script.secretCiphertext) : "";
    result = await executeHttpCheckin({ config: script.config, secret, timezone: script.timezone }, { fetchImpl });
  } catch (error) {
    result = errorResult("SECRET_UNAVAILABLE", error?.message || "Secret could not be decrypted");
  }
  const finishedAt = Date.now();
  const preview = redactCheckinText(result.responsePreview || "", secret).replace(/\s+/g, " ").trim().slice(0, 700);
  const summary = redactCheckinText([result.summary || result.errorMessage || "", preview].filter(Boolean).join(" · "), secret).slice(0, 1000);
  return finishCheckinRun(run.id, {
    status: result.success ? "succeeded" : result.errorCode === "TIMED_OUT" ? "timed_out" : "failed",
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    httpStatus: result.httpStatus ?? null,
    summary,
    errorCode: result.errorCode || "",
    errorMessage: result.errorMessage || "",
  });
}

export async function startManualCheckinRun(script) {
  const { createManualCheckinRun } = await import("@/lib/db/index.js");
  const run = await createManualCheckinRun(script.id);
  if (!run) return null;
  void executeCheckinRun(script, run).catch((error) => console.error(`[Checkin] manual run ${run.id} failed:`, error?.message || error));
  return run;
}
