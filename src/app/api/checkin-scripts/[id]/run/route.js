import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession.js";
import { getCheckinScriptById } from "@/lib/db/index.js";
import { startManualCheckinRun } from "@/lib/checkin/runner.js";

export async function POST(request, { params }) {
  if (!await requireDashboardAuth(request) || !await verifyDashboardPassword(request.headers.get("x-9r-password"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    const script = await getCheckinScriptById(id);
    if (!script) return NextResponse.json({ error: "Check-in script not found" }, { status: 404 });
    const run = await startManualCheckinRun(script);
    if (!run) return NextResponse.json({ error: "A run is already in progress" }, { status: 409 });
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    console.error("Error starting check-in run:", error);
    return NextResponse.json({ error: "Failed to start check-in run" }, { status: 500 });
  }
}
