import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { getDb } from "@/lib/server/firebase-admin";

export const PAYMENT_AUDIT_COLLECTION = "payment_audit";

type AuditPatch = Record<string, unknown>;

function cleanForFirestore(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date || value instanceof Timestamp || value instanceof FieldValue) return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanForFirestore(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const cleaned: AuditPatch = {};
    for (const [key, nestedValue] of Object.entries(value as AuditPatch)) {
      const nextValue = cleanForFirestore(nestedValue);
      if (nextValue !== undefined) cleaned[key] = nextValue;
    }
    return cleaned;
  }
  return value;
}

function summarizeStatus(status: unknown) {
  if (status === "captured") return "success";
  if (status === "failed" || status === "cancel_pending") return "failed";
  if (status === "confirm_required") return "needs_manual_confirmation";
  return status;
}

function categorizeFailure(event: string, metadata?: AuditPatch): "USER" | "PROVIDER" | "STATION" | "SYSTEM" | "UNKNOWN" {
  const msg = (metadata?.error || metadata?.failureNote || "").toString().toLowerCase();
  const providerCode = metadata?.providerErrorCode || "";

  // 1. User-led failures
  if (
    event.includes("USER_CANCELLED") || 
    msg.includes("user cancelled") ||
    providerCode === "5001" // Example Waafi user cancel code
  ) return "USER";

  // 2. Provider-led failures
  if (
    event.includes("PROVIDER") || 
    msg.includes("provider") || 
    msg.includes("waafi") ||
    (providerCode && providerCode !== "0")
  ) return "PROVIDER";

  // 3. Station-led failures
  if (
    event.includes("EJECTION") || 
    event.includes("UNLOCK") || 
    event.includes("VERIFICATION") ||
    msg.includes("station") || 
    msg.includes("hardware") || 
    msg.includes("timed out") ||
    msg.includes("battery")
  ) return "STATION";

  // 4. System-led failures
  if (
    event.includes("RENTAL_CREATION") || 
    event.includes("DATABASE") ||
    msg.includes("internal")
  ) return "SYSTEM";

  return "UNKNOWN";
}

function summarizeProviderResponse(metadata?: AuditPatch) {
  const providerResponse = metadata?.providerResponse as AuditPatch | undefined;
  const params = providerResponse?.params as AuditPatch | undefined;
  
  return {
    providerErrorCode: providerResponse?.errorCode || metadata?.providerErrorCode,
    providerResponseCode: providerResponse?.responseCode ?? params?.responseCode ?? metadata?.providerResponseCode,
    providerResponseMsg: providerResponse?.responseMsg ?? params?.responseMsg ?? metadata?.providerResponseMsg,
    providerDescription: params?.description || metadata?.providerDescription,
    providerOrderId: params?.orderId || metadata?.providerOrderId,
    providerRef: params?.transactionId || metadata?.providerRef || metadata?.providerReferenceId,
  };
}

export function auditPatchFromTransactionPatch(patch: AuditPatch) {
  const delivery = patch.delivery as AuditPatch | undefined;
  const status = patch.status;

  return cleanForFirestore({
    status,
    outcome: summarizeStatus(status),
    providerRef: patch.providerRef,
    providerIssuerRef: patch.providerIssuerRef,
    providerReferenceId: patch.providerReferenceId,
    failureReason: patch.failureReason,
    failureStage: patch.failureStage,
    failureCategory: patch.failureCategory,
    unlockStarted: patch.unlockStarted,
    unlockCompleted: patch.unlockCompleted,
    unlockFailed: patch.unlockFailed,
    unlockRetryCount: patch.unlockRetryCount,
    lastUnlockAttemptAt: patch.lastUnlockAttemptAt,
    verifiedAt: patch.verifiedAt,
    capturedAt: patch.capturedAt,
    captureAttempted: patch.captureAttempted,
    captureAttemptedAt: patch.captureAttemptedAt,
    captureCompleted: patch.captureCompleted,
    providerCaptureRef: patch.providerCaptureRef,
    rentalCreated: patch.rentalCreated,
    rentalId: patch.rentalId,
    debugChecklist: patch.debugChecklist,
    finalStep: patch.finalStep,
    processingTimeMs: patch.processingTimeMs,
    eventCount: patch.eventCount,
    imei: delivery?.imei,
    stationCode: delivery?.stationCode,
    batteryId: delivery?.batteryId,
    slotId: delivery?.slotId,
    requestedPhoneNumber: delivery?.requestedPhoneNumber,
    canonicalPhoneNumber: delivery?.canonicalPhoneNumber,
    phoneAuthority: delivery?.phoneAuthority,
  }) as AuditPatch;
}

export async function updatePaymentAudit(transactionId: string, patch: AuditPatch) {
  if (!transactionId) return;

  const cleaned = cleanForFirestore(patch) as AuditPatch;
  await getDb()
    .collection(PAYMENT_AUDIT_COLLECTION)
    .doc(transactionId)
    .set(
      {
        id: transactionId,
        transactionId,
        ...cleaned,
        updatedAt: Date.now(),
        updatedAtTs: Timestamp.now(),
      },
      { merge: true },
    );
}

export async function recordPaymentAuditEvent(
  transactionId: string,
  event: string,
  metadata?: AuditPatch,
  level?: string,
) {
  if (!transactionId) return;

  const level_normalized = level || (event.includes("FAILED") || event.includes("ERROR") ? "CRITICAL" : "IMPORTANT");
  const category = (event.includes("FAILED") || event.includes("ERROR")) ? categorizeFailure(event, metadata) : undefined;

  await updatePaymentAudit(transactionId, {
    lastEvent: event,
    lastEventLevel: level_normalized,
    lastEventAt: Date.now(),
    eventCount: FieldValue.increment(1),
    failureCategory: category,
    ...summarizeProviderResponse(metadata),
    ...(metadata?.phone ? { phone: metadata.phone } : {}),
    ...(metadata?.amount ? { amount: metadata.amount } : {}),
    ...(metadata?.batteryId ? { batteryId: metadata.batteryId } : {}),
    ...(metadata?.slotId ? { slotId: metadata.slotId } : {}),
    ...(metadata?.station ? { stationCode: metadata.station } : {}),
    ...(metadata?.stationId ? { returnStationId: metadata.stationId } : {}),
    ...(metadata?.failureNote ? { failureReason: metadata.failureNote } : {}),
    ...(metadata?.error ? { lastError: metadata.error } : {}),
  });
}
