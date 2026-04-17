import { getDb } from "@/lib/server/firebase-admin";
import { sendWhatsAppAlert } from "@/lib/server/alerts/whatsapp";

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

export async function logError(input: LogErrorInput): Promise<void> {
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
  } catch (error) {
    console.error(
      "Failed to write error log:",
      error instanceof Error ? error.message : error,
    );
  }

  if (!isCriticalErrorType(input.type)) {
    return;
  }

  try {
    await sendWhatsAppAlert(formatAlert(input));
  } catch (error) {
    console.error(
      "Failed to dispatch WhatsApp alert from error logger:",
      error instanceof Error ? error.message : error,
    );
  }
}

