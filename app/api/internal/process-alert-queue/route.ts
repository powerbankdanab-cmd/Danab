import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { sendWhatsAppAlertWithResult } from "@/lib/server/alerts/whatsapp";
import { getOptionalEnv } from "@/lib/server/env";

export const maxDuration = 300;

function isAuthorized(request: NextRequest) {
  const secret = getOptionalEnv("INTERNAL_CRON_TOKEN") || getOptionalEnv("RECONCILE_CRON_SECRET");
  if (!secret) {
    return true; // For local dev without secret
  }

  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization") || "";
  return authHeader === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const now = Date.now();
  
  try {
    const snapshot = await db.collection("alerts_queue")
      .where("nextAttemptAt", "<=", now)
      .limit(10)
      .get();

    if (snapshot.empty) {
      return NextResponse.json({ processed: 0 });
    }

    let processed = 0;
    let failed = 0;

    for (const doc of snapshot.docs) {
      const alert = doc.data();
      let alertStatus;
      
      try {
        alertStatus = await sendWhatsAppAlertWithResult(alert.message);
      } catch (err) {
        console.error("Alert worker failed to send alert:", err);
        alertStatus = "failed";
      }

      if (alertStatus === "sent") {
        await doc.ref.delete();
        processed++;
      } else if (alert.retries >= 5) {
        // Dead letter
        await doc.ref.update({
          nextAttemptAt: now + 3600 * 1000 * 24 * 365,
          failedPermanently: true,
          updatedAt: now
        });
        failed++;
      } else {
        // Exponential backoff
        await doc.ref.update({
          retries: alert.retries + 1,
          nextAttemptAt: now + Math.pow(2, alert.retries) * 10000,
          updatedAt: now
        });
        failed++;
      }
    }

    // Step 5: Worker Heartbeat
    await db.doc("system_status/alert_worker").set({
      lastRunAt: Date.now()
    }, { merge: true });

    return NextResponse.json({ processed, failed });
  } catch (error) {
    console.error("Critical error in process-alert-queue:", error);
    return NextResponse.json(
      { error: "Failed to process alert queue", details: String(error) },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
