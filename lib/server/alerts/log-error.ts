import { getDb } from "@/lib/server/firebase-admin";
import {
  sendWhatsAppAlertWithResult,
  type WhatsAppAlertResult,
} from "@/lib/server/alerts/whatsapp";

export const CRITICAL_ERROR_TYPES = {
  VERIFICATION_FAILED: "VERIFICATION_FAILED",
  CAPTURE_UNKNOWN: "CAPTURE_UNKNOWN",
  RECONCILIATION_FAILED: "RECONCILIATION_FAILED",
  SYSTEM_INCONSISTENCY: "SYSTEM_INCONSISTENCY",
  DELIVERY_VERIFICATION: "DELIVERY_VERIFICATION",
  FALSE_EJECTION_PATTERN: "FALSE_EJECTION_PATTERN",
  VERIFICATION_TIMEOUT: "VERIFICATION_TIMEOUT",
  // Phase 4: Financial safety alerts (Tier 1 — WhatsApp immediate)
  CAPTURE_INCONSISTENCY: "CAPTURE_INCONSISTENCY_DETECTED",
  CAPTURE_RETRY_EXHAUSTED: "CAPTURE_RETRY_EXHAUSTED",
  RENTAL_CREATION_FAILED: "RENTAL_CREATION_FAILED",
  CAPTURE_FAIL_BLOCKED: "CAPTURE_FAIL_BLOCKED",
  SLA_BREACH_DETECTED: "SLA_BREACH_DETECTED",
  PROVIDER_CANCEL_FAILED: "PROVIDER_CANCEL_FAILED",
  CRITICAL_SPLIT_BRAIN_DETECTED: "CRITICAL_SPLIT_BRAIN_DETECTED",
} as const;

export type CriticalErrorType =
  (typeof CRITICAL_ERROR_TYPES)[keyof typeof CRITICAL_ERROR_TYPES];

export type ErrorType = CriticalErrorType | string;

export type LogErrorInput = {
  type: ErrorType;
  transactionId?: string;
  providerRef?: string;
  stationCode?: string;
  phoneNumber?: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type LogErrorResult = {
  logged: boolean;
  alertStatus: WhatsAppAlertResult | null;
};

// --- In-memory tracking for deduplication ---
const lastAlertSent = new Map<string, number>();

function isDuplicateAlert(transactionId: string | undefined, type: ErrorType): boolean {
  if (!transactionId) return false;
  
  const key = `${transactionId}_${type}`;
  const now = Date.now();
  const last = lastAlertSent.get(key);
  
  if (last && now - last < 10000) {
    return true;
  }
  
  // Cleanup memory map
  if (lastAlertSent.size > 500) {
    for (const [k, v] of lastAlertSent.entries()) {
      if (now - v > 60000) lastAlertSent.delete(k);
    }
  }
  
  return false;
}

function markAlertSent(transactionId: string | undefined, type: ErrorType) {
  if (!transactionId) return;
  const key = `${transactionId}_${type}`;
  lastAlertSent.set(key, Date.now());
}

async function detectStationFailures(stationCode: string | undefined) {
  if (!stationCode) return;
  
  const now = Date.now();
  const db = getDb();
  const ref = db.collection("station_failures").doc(stationCode);

  try {
    const alertTriggered = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      let failures: number[] = [];
      if (doc.exists) {
        failures = doc.data()?.timestamps || [];
      }

      failures = failures.filter(t => now - t <= 10 * 60 * 1000);
      failures.push(now);

      tx.set(ref, { stationCode, timestamps: failures }, { merge: true });

      return failures.length === 5; // Exactly 5 triggers the alert to prevent spam
    });

    if (alertTriggered) {
      await sendWhatsAppAlertWithResult(`⚠️ Station ${stationCode} likely broken (5+ failures in 10 min)`);
    }
  } catch (err) {
    console.error(`[ALERT_EXCEPTION] Failed to track/send station broken alert for ${stationCode}:`, err);
  }
}

async function queueDurableAlert(input: LogErrorInput) {
  try {
    await getDb()
      .collection("alerts_queue")
      .add({
        type: input.type,
        transactionId: input.transactionId || null,
        message: formatAlert(input),
        retries: 0,
        nextAttemptAt: Date.now() + 5000,
        createdAt: Date.now(),
      });
  } catch (error) {
    console.error(
      "[CRITICAL] Failed to enqueue durable alert:",
      error instanceof Error ? error.message : String(error),
      "Payload:",
      formatAlert(input)
    );
  }
}

function isCriticalErrorType(type: ErrorType): type is CriticalErrorType {
  return Object.values(CRITICAL_ERROR_TYPES).includes(type as CriticalErrorType);
}

function formatAlert(input: LogErrorInput) {
  return [
    "DANAB ALERT",
    `Type: ${input.type}`,
    `Station: ${input.stationCode || "-"}`,
    `Phone: ${input.phoneNumber || "-"}`,
    `Tx (Idempotency): ${input.transactionId || "-"}`,
    `Provider Ref: ${input.providerRef || "-"}`,
    `Message: ${input.message}`,
  ].join("\n");
}

/**
 * Structured error logger with guaranteed visibility.
 *
 * GUARANTEES:
 * 1. Critical errors are ALWAYS written to console (defense-in-depth)
 * 2. Firestore write is attempted; if it fails, full payload is dumped to console
 * 3. WhatsApp alert is attempted for critical types; if rate-limited, alert
 *    content is logged to console so server logs always contain it
 * 4. This function NEVER throws — it returns a result describing what happened
 */
export async function logError(input: LogErrorInput): Promise<LogErrorResult> {
  const isCritical = isCriticalErrorType(input.type);

  // GUARANTEE: Critical errors always appear in runtime logs regardless
  // of Firestore/WhatsApp success. This is the last line of defense.
  if (isCritical) {
    console.error(
      `[CRITICAL_ERROR] ${formatAlert(input)}`,
      input.metadata ? JSON.stringify(input.metadata) : "",
    );
  }

  // Attempt Firestore persistence
  let logged = false;
  try {
    await getDb()
      .collection("errors")
      .add({
        type: input.type,
        ...(input.transactionId ? { transactionId: input.transactionId } : {}),
        ...(input.providerRef ? { providerRef: input.providerRef } : {}),
        ...(input.stationCode ? { stationCode: input.stationCode } : {}),
        ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
        message: input.message,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        createdAt: Date.now(),
      });
    logged = true;
  } catch (error) {
    // Firestore write failed — dump full payload to console so it is
    // NEVER silently lost. Container/runtime logs become the fallback.
    console.error(
      "[CRITICAL] Failed to write error to Firestore — dumping full payload:",
      JSON.stringify({
        type: input.type,
        transactionId: input.transactionId,
        providerRef: input.providerRef,
        stationCode: input.stationCode,
        phoneNumber: input.phoneNumber,
        message: input.message,
        metadata: input.metadata,
        firestoreError: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  if (input.stationCode) {
    void detectStationFailures(input.stationCode);
  }

  // Only attempt WhatsApp alert for critical error types
  if (!isCritical) {
    return { logged, alertStatus: null };
  }

  // Persistent deduplication to prevent alert fatigue
  if (input.transactionId) {
    try {
      const lockRef = getDb().collection("alert_locks").doc(`${input.transactionId}_${input.type}`);
      await lockRef.create({ createdAt: Date.now() });
    } catch (e: any) {
      if (e.code === 6) { // ALREADY_EXISTS
        console.warn(`[ALERT_DEDUPLICATED] Skipping duplicate alert for Tx: ${input.transactionId}, Type: ${input.type}`);
        return { logged, alertStatus: null };
      }
    }
  } else if (isDuplicateAlert(input.transactionId, input.type)) {
    // Fallback to in-memory deduplication if no transactionId
    console.warn(`[ALERT_DEDUPLICATED] Skipping duplicate alert for Tx: unknown, Type: ${input.type}`);
    return { logged, alertStatus: null };
  }

  try {
    const alertStatus = await sendWhatsAppAlertWithResult(formatAlert(input));
    
    if (alertStatus === "sent") {
      markAlertSent(input.transactionId, input.type);
    } else if (alertStatus === "rate_limited" || alertStatus === "failed") {
      // Step 5: Queue durable alert for retry
      await queueDurableAlert(input);
    }

    // Logging side-effects
    if (alertStatus === "rate_limited") {
      console.error(
        "[ALERT_RATE_LIMITED] WhatsApp alert rate-limited — enqueued for eventual delivery:",
        formatAlert(input),
      );
    } else if (alertStatus === "missing_config") {
      console.error(
        "[ALERT_NO_CONFIG] WhatsApp not configured — critical alert NOT sent:",
        formatAlert(input),
      );
    } else if (alertStatus === "failed") {
      console.error(
        "[ALERT_FAILED] WhatsApp alert delivery failed — enqueued for eventual delivery:",
        formatAlert(input),
      );
    }

    return { logged, alertStatus };
  } catch (error) {
    console.error(
      "[ALERT_EXCEPTION] Unexpected WhatsApp alert failure. Enqueuing for eventual delivery. Error:",
      error instanceof Error ? error.message : error,
      "— alert content:",
      formatAlert(input),
    );
    await queueDurableAlert(input);
    return { logged, alertStatus: "failed" };
  }
}
