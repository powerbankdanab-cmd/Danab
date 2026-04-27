import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { PAYMENT_TRANSACTIONS_COLLECTION, PaymentTransactionRecord, toMillis } from "@/lib/server/payment/transactions";
import { logError, CRITICAL_ERROR_TYPES } from "@/lib/server/alerts/log-error";
import { getOptionalEnv } from "@/lib/server/env";

function isAuthorized(request: NextRequest) {
  const secret = getOptionalEnv("INTERNAL_CRON_TOKEN") || getOptionalEnv("CRON_SECRET");
  if (!secret) return true;
  const authHeader = request.headers.get("authorization") || "";
  return authHeader === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const now = Date.now();
  const SLA_MS = 45000;
  const CANCEL_TIMEOUT_MS = 120000;

  const violations: Array<{ id: string; type: string; details: any }> = [];

  try {
    // 1. Invariant: held && !unlockStarted (Age > 5s)
    const heldStuckSnap = await db.collection(PAYMENT_TRANSACTIONS_COLLECTION)
      .where("status", "==", "held")
      .where("unlockStarted", "==", false)
      .get();

    for (const doc of heldStuckSnap.docs) {
      const tx = doc.data() as PaymentTransactionRecord;
      const age = now - (toMillis(tx.heldAt ?? tx.updatedAt) ?? now);
      if (age > 5000) {
        violations.push({ id: doc.id, type: "STUCK_HELD_NO_UNLOCK", details: { age } });
      }
    }

    // 2. Invariant: verified && !captureCompleted
    const verifiedStuckSnap = await db.collection(PAYMENT_TRANSACTIONS_COLLECTION)
      .where("status", "==", "verified")
      .where("captureCompleted", "==", false)
      .get();

    for (const doc of verifiedStuckSnap.docs) {
      violations.push({ id: doc.id, type: "STUCK_VERIFIED_NO_CAPTURE", details: {} });
    }

    // 3. Invariant: cancel_pending > 2min
    const cancelStuckSnap = await db.collection(PAYMENT_TRANSACTIONS_COLLECTION)
      .where("status", "==", "cancel_pending")
      .get();

    for (const doc of cancelStuckSnap.docs) {
      const tx = doc.data() as PaymentTransactionRecord;
      const age = now - (toMillis(tx.updatedAt) ?? now);
      if (age > CANCEL_TIMEOUT_MS) {
        violations.push({ id: doc.id, type: "STUCK_CANCEL_PENDING", details: { age } });
      }
    }

    // 4. Invariant: unlockStarted && !unlockCompleted && age > SLA
    const unlockInProgressSnap = await db.collection(PAYMENT_TRANSACTIONS_COLLECTION)
      .where("status", "==", "held")
      .where("unlockStarted", "==", true)
      .where("unlockCompleted", "==", false)
      .where("unlockFailed", "==", false)
      .get();

    for (const doc of unlockInProgressSnap.docs) {
      const tx = doc.data() as PaymentTransactionRecord;
      const age = now - (toMillis(tx.lastUnlockAttemptAt ?? tx.updatedAt) ?? now);
      if (age > SLA_MS) {
        violations.push({ id: doc.id, type: "SLA_BREACH_UNLOCK_STUCK", details: { age } });
      }
    }

    // Log all violations
    for (const v of violations) {
      await logError({
        type: CRITICAL_ERROR_TYPES.SYSTEM_INCONSISTENCY,
        transactionId: v.id,
        message: `System Invariant Violation: ${v.type}`,
        metadata: v.details,
      });
    }

    return NextResponse.json({
      timestamp: now,
      violationCount: violations.length,
      violations
    });
  } catch (error) {
    console.error("Invariant audit failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
