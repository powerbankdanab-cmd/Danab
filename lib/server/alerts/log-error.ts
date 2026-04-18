import { getDb } from "@/lib/server/firebase-admin";
import {
  sendWhatsAppAlertWithResult,
  type WhatsAppAlertResult,
} from "@/lib/server/alerts/whatsapp";

export const CRITICAL_ERROR_TYPES = {
  VERIFICATION_FAILED: "VERIFICATION_FAILED",
  CAPTURE_UNKNOWN: "CAPTURE_UNKNOWN",
  RECONCILIATION_FAILED: "RECONCILIATION_FAILED",
} as const;

export type CriticalErrorType =
  (typeof CRITICAL_ERROR_TYPES)[keyof typeof CRITICAL_ERROR_TYPES];

export type ErrorType = CriticalErrorType | string;

export type LogErrorInput = {
  type: ErrorType;
  transactionId?: string;
  stationCode?: string;
  phoneNumber?: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type LogErrorResult = {
  logged: boolean;
  alertStatus: WhatsAppAlertResult | null;
};

function isCriticalErrorType(type: ErrorType): type is CriticalErrorType {
  return Object.values(CRITICAL_ERROR_TYPES).includes(type as CriticalErrorType);
}

function formatAlert(input: LogErrorInput) {
  return [
    "DANAB ALERT",
    `Type: ${input.type}`,
    `Station: ${input.stationCode || "-"}`,
    `Phone: ${input.phoneNumber || "-"}`,
    `Tx: ${input.transactionId || "-"}`,
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
        stationCode: input.stationCode,
        phoneNumber: input.phoneNumber,
        message: input.message,
        metadata: input.metadata,
        firestoreError: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // Only attempt WhatsApp alert for critical error types
  if (!isCritical) {
    return { logged, alertStatus: null };
  }

  try {
    const alertStatus = await sendWhatsAppAlertWithResult(formatAlert(input));

    // If WhatsApp was rate-limited, the alert was NOT delivered.
    // Log the full alert content to console so it's captured in server logs.
    if (alertStatus === "rate_limited") {
      console.error(
        "[ALERT_RATE_LIMITED] WhatsApp alert was rate-limited — alert content logged for visibility:",
        formatAlert(input),
      );
    } else if (alertStatus === "missing_config") {
      console.error(
        "[ALERT_NO_CONFIG] WhatsApp not configured — critical alert NOT sent:",
        formatAlert(input),
      );
    } else if (alertStatus === "failed") {
      console.error(
        "[ALERT_FAILED] WhatsApp alert delivery failed — alert content:",
        formatAlert(input),
      );
    }

    return { logged, alertStatus };
  } catch (error) {
    console.error(
      "[ALERT_EXCEPTION] Unexpected WhatsApp alert failure:",
      error instanceof Error ? error.message : error,
      "— alert content:",
      formatAlert(input),
    );
    return { logged, alertStatus: "failed" };
  }
}
