import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";

export async function GET(request: NextRequest) {
  const token = request.headers.get("x-internal-key");
  if (!token || token !== process.env.INTERNAL_ALERT_TEST_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const db = getDb();
  
  const twilioConfigured = !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM &&
    process.env.TWILIO_WHATSAPP_TO
  );

  let queuePendingCount = 0;
  try {
    // Successful alerts are deleted, so docs remaining in collection represent pending or dead-letter queue
    const qSnap = await db.collection("alerts_queue").get();
    queuePendingCount = qSnap.size;
  } catch (err) {
    console.error("Health check error fetching queue:", err);
  }

  let lastWorkerRunAt: number | null = null;
  try {
    const doc = await db.doc("system_status/alert_worker").get();
    if (doc.exists) {
      lastWorkerRunAt = doc.data()?.lastRunAt || null;
    }
  } catch (err) {
    console.error("Health check error fetching heartbeat:", err);
  }

  const now = Date.now();
  // Worker is stale if hasn't run in > 15 minutes, or never ran
  const workerStale = !lastWorkerRunAt || now - lastWorkerRunAt > 15 * 60 * 1000;
  
  const systemStatus = (workerStale || queuePendingCount > 50) ? "degraded" : "healthy";

  return NextResponse.json({
    twilioConfigured,
    queuePendingCount,
    lastWorkerRunAt,
    systemStatus,
  });
}
