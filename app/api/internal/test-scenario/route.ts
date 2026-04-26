import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { finalizeCapture } from "@/lib/server/payment-service";
import { logError, CRITICAL_ERROR_TYPES } from "@/lib/server/alerts/log-error";
import { PAYMENT_TRANSACTIONS_COLLECTION } from "@/lib/server/payment/transactions";
import { getOptionalEnv } from "@/lib/server/env";

export const maxDuration = 60;

function isAuthorized(request: NextRequest) {
  const secret = getOptionalEnv("INTERNAL_CRON_TOKEN") || getOptionalEnv("CRON_SECRET") || getOptionalEnv("RECONCILE_CRON_SECRET");
  if (!secret) {
    return true; // For local dev without secret
  }

  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization") || "";
  return authHeader === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  // Hard disable in production — attack surface removal
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const txId = `test_sim_${Date.now()}`;

  const logs: string[] = [];

  logs.push("1. Simulating 'captured && rentalCreated = false' state...");
  await db.collection(PAYMENT_TRANSACTIONS_COLLECTION).doc(txId).set({
    id: txId,
    status: "captured",
    rentalCreated: false,
    captureCompleted: true,
    amount: 10,
    phone: "252610000000",
    station: "TEST01",
    delivery: {
      batteryId: "BATT_TEST",
      slotId: "1",
      imei: "1234567890",
      stationCode: "TEST01",
      canonicalPhoneNumber: "252610000000",
      requestedPhoneNumber: "610000000",
      phoneAuthority: "waafi",
    },
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
  });

  logs.push("2. Manually triggering the Tier 1 alert for RENTAL_CREATION_FAILED (as if it just failed)...");
  await logError({
    type: CRITICAL_ERROR_TYPES.RENTAL_CREATION_FAILED,
    transactionId: txId,
    message: "CRITICAL: Payment captured but rental creation failed (SIMULATION)",
    stationCode: "TEST01",
  });

  logs.push("3. Running finalizeCapture (which is what reconciliation does to fix it)...");
  try {
    await finalizeCapture(txId);
    logs.push("finalizeCapture executed successfully.");
  } catch (e: any) {
    logs.push(`Error during finalizeCapture: ${e.message}`);
  }

  const updatedTx = await db.collection(PAYMENT_TRANSACTIONS_COLLECTION).doc(txId).get();
  logs.push("4. Final state in Firestore:");
  logs.push(JSON.stringify(updatedTx.data(), null, 2));

  return new NextResponse(logs.join("\n\n"), {
    headers: { "Content-Type": "text/plain" },
  });
}
