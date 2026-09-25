import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession.js";
import { getCheckinScriptById, deleteCheckinScript, updateCheckinScript } from "@/lib/db/index.js";
import { getNextCheckinRun } from "@/lib/checkin/cron.js";
import { normalizeCheckinScriptInput, redactCheckinConfig } from "@/lib/checkin/validation.js";
import { encryptCheckinSecret, isCheckinSecretEncryptionAvailable } from "@/lib/checkin/secretCrypto.js";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { readBoundedJson } from "@/lib/checkin/requestBody.js";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function canWrite(request) {
  if (!await requireDashboardAuth(request)) return false;
  return verifyDashboardPassword(request.headers.get("x-9r-password"));
}

function toDto(script) {
  return {
    id: script.id,
    name: script.name,
    enabled: script.enabled,
    scheduleType: script.scheduleType,
    cronExpr: script.cronExpr,
    timezone: script.timezone,
    nextRunAt: script.nextRunAt,
    lastRunAt: script.lastRunAt,
    config: redactCheckinConfig(script.config),
    hasSecret: Boolean(script.secretCiphertext),
    createdAt: script.createdAt,
    updatedAt: script.updatedAt,
  };
}

function prepareInput(body, existing) {
  const normalized = normalizeCheckinScriptInput({
    ...body,
    secretAction: body.secretAction || (body.secret ? "replace" : "keep"),
  });
  if (normalized.error) return normalized;
  const value = normalized.value;
  const config = { ...value.config };
  if (existing.config && config.bodyOmitted === true) config.body = existing.config.body || "";
  delete config.bodyOmitted;
  let secretCiphertext = existing.secretCiphertext || "";
  if (value.secretAction === "clear") secretCiphertext = "";
  if (value.secretAction === "replace") {
    if (!isCheckinSecretEncryptionAvailable()) return { error: "Secret encryption is unavailable" };
    try {
      secretCiphertext = encryptCheckinSecret(value.secret);
    } catch (error) {
      return { error: error?.message || "Secret could not be encrypted" };
    }
  }
  return { value: { ...value, config, secretCiphertext } };
}

function getNextRun(input) {
  if (!input.enabled || input.scheduleType !== "cron") return null;
  return getNextCheckinRun(input.cronExpr, input.timezone, Date.now());
}

async function validatePublicTarget(url) {
  try {
    await assertPublicUrl(url);
    return null;
  } catch {
    return "Target URL must be public";
  }
}

export async function PUT(request, { params }) {
  if (!await canWrite(request)) return unauthorized();
  try {
    const parsed = await readBoundedJson(request);
    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { id } = await params;
    const existing = await getCheckinScriptById(id);
    if (!existing) return NextResponse.json({ error: "Check-in script not found" }, { status: 404 });
    const prepared = prepareInput(parsed.body, existing);
    if (prepared.error) return NextResponse.json({ error: prepared.error }, { status: 400 });
    const value = prepared.value;
    const targetError = await validatePublicTarget(value.config.url);
    if (targetError) return NextResponse.json({ error: targetError }, { status: 400 });
    let nextRunAt;
    try {
      nextRunAt = getNextRun(value);
    } catch (error) {
      return NextResponse.json({ error: error?.message || "Invalid schedule" }, { status: 400 });
    }
    const script = await updateCheckinScript(id, {
      name: value.name,
      enabled: value.enabled,
      scheduleType: value.scheduleType,
      cronExpr: value.cronExpr,
      timezone: value.timezone,
      nextRunAt,
      config: value.config,
      secretCiphertext: value.secretCiphertext,
    });
    return NextResponse.json({ script: toDto(script) });
  } catch (error) {
    console.error("Error updating check-in script:", error);
    return NextResponse.json({ error: "Failed to update check-in script" }, { status: 500 });
  }
}

export async function GET(request, { params }) {
  if (!await requireDashboardAuth(request)) return unauthorized();
  try {
    const { id } = await params;
    const script = await getCheckinScriptById(id);
    if (!script) return NextResponse.json({ error: "Check-in script not found" }, { status: 404 });
    return NextResponse.json({ script: toDto(script) });
  } catch (error) {
    console.error("Error loading check-in script:", error);
    return NextResponse.json({ error: "Failed to load check-in script" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  if (!await canWrite(request)) return unauthorized();
  try {
    const { id } = await params;
    const removed = await deleteCheckinScript(id);
    if (removed?.busy) return NextResponse.json({ error: "A run is currently in progress" }, { status: 409 });
    if (!removed) return NextResponse.json({ error: "Check-in script not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting check-in script:", error);
    return NextResponse.json({ error: "Failed to delete check-in script" }, { status: 500 });
  }
}
