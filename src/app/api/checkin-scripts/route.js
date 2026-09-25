import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession.js";
import { getNextCheckinRun } from "@/lib/checkin/cron.js";
import { normalizeCheckinScriptInput, redactCheckinConfig } from "@/lib/checkin/validation.js";
import { encryptCheckinSecret, isCheckinSecretEncryptionAvailable } from "@/lib/checkin/secretCrypto.js";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { readBoundedJson } from "@/lib/checkin/requestBody.js";
import {
  createCheckinScript,
  getCheckinScriptById,
  listCheckinScripts,
  updateCheckinScript,
} from "@/lib/db/index.js";

const PASSWORD_HEADER = "x-9r-password";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function canRead(request) {
  return requireDashboardAuth(request);
}

async function canWrite(request) {
  if (!await requireDashboardAuth(request)) return false;
  return verifyDashboardPassword(request.headers.get(PASSWORD_HEADER));
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

function prepareInput(body, existing = null) {
  const input = {
    ...body,
    secretAction: body.secretAction || (body.secret ? "replace" : existing ? "keep" : "keep"),
  };
  const normalized = normalizeCheckinScriptInput(input);
  if (normalized.error) return normalized;
  const value = normalized.value;
  const config = { ...value.config };
  if (existing?.config && config.bodyOmitted === true) config.body = existing.config.body || "";
  delete config.bodyOmitted;
  let secretCiphertext = existing?.secretCiphertext || "";
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

export async function GET(request) {
  if (!await canRead(request)) return unauthorized();
  try {
    const scripts = await listCheckinScripts();
    return NextResponse.json({
      scripts: scripts.map(toDto),
      runtime: { secretEncryption: isCheckinSecretEncryptionAvailable() },
    });
  } catch (error) {
    console.error("Error listing check-in scripts:", error);
    return NextResponse.json({ error: "Failed to list check-in scripts" }, { status: 500 });
  }
}

export async function POST(request) {
  if (!await canWrite(request)) return unauthorized();
  const parsed = await readBoundedJson(request);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const prepared = prepareInput(parsed.body);
  if (prepared.error) return NextResponse.json({ error: prepared.error }, { status: 400 });
  try {
    const value = prepared.value;
    const targetError = await validatePublicTarget(value.config.url);
    if (targetError) return NextResponse.json({ error: targetError }, { status: 400 });
    let nextRunAt;
    try {
      nextRunAt = getNextRun(value);
    } catch (error) {
      return NextResponse.json({ error: error?.message || "Invalid schedule" }, { status: 400 });
    }
    const script = await createCheckinScript({
      name: value.name,
      enabled: value.enabled,
      scheduleType: value.scheduleType,
      cronExpr: value.cronExpr,
      timezone: value.timezone,
      nextRunAt,
      config: value.config,
      secretCiphertext: value.secretCiphertext,
    });
    return NextResponse.json({ script: toDto(script) }, { status: 201 });
  } catch (error) {
    console.error("Error creating check-in script:", error);
    return NextResponse.json({ error: "Failed to create check-in script" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  if (!await canWrite(request)) return unauthorized();
  const parsed = await readBoundedJson(request);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
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
