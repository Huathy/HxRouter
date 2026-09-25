import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { getCheckinScriptById, listCheckinRuns } from "@/lib/db/index.js";
import { decryptCheckinSecret } from "@/lib/checkin/secretCrypto.js";
import { redactCheckinText } from "@/lib/checkin/httpCheckinExecutor.js";

export async function GET(request, { params }) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id } = await params;
    const script = await getCheckinScriptById(id);
    if (!script) return NextResponse.json({ error: "Check-in script not found" }, { status: 404 });
    const limit = Number(new URL(request.url).searchParams.get("limit") || 50);
    const runs = await listCheckinRuns(id, limit);
    let secret = "";
    let canRedact = true;
    if (script.secretCiphertext) {
      try {
        secret = decryptCheckinSecret(script.secretCiphertext);
      } catch {
        canRedact = false;
      }
    }
    return NextResponse.json({
      runs: runs.map((run) => {
        const sensitiveRun = Boolean(script.secretCiphertext) || run.secretConfigured !== false;
        return {
          ...run,
          summary: sensitiveRun ? "[REDACTED]" : (canRedact ? redactCheckinText(run.summary, secret) : "[REDACTED]"),
          errorMessage: sensitiveRun ? "[REDACTED]" : (canRedact ? redactCheckinText(run.errorMessage, secret) : "[REDACTED]"),
        };
      }),
    });
  } catch (error) {
    console.error("Error listing check-in runs:", error);
    return NextResponse.json({ error: "Failed to list check-in runs" }, { status: 500 });
  }
}
