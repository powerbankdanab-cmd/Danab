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

function summarizeProviderResponse(metadata?: AuditPatch) {
  const providerResponse = metadata?.providerResponse as AuditPatch | undefined;
  if (!providerResponse) return {};

  const params = providerResponse.params as AuditPatch | undefined;
  return {
    providerErrorCode: providerResponse.errorCode,
    providerResponseCode: providerResponse.responseCode ?? params?.responseCode,
    providerResponseMsg: providerResponse.responseMsg ?? params?.responseMsg,
    providerDescription: params?.description,
    providerOrderId: params?.orderId,
    providerResponseId: params?.responseId,
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

  await updatePaymentAudit(transactionId, {
    lastEvent: event,
    lastEventLevel: level,
    lastEventAt: Date.now(),
    eventCount: FieldValue.increment(1),
    ...summarizeProviderResponse(metadata),
    ...(metadata?.phone ? { phone: metadata.phone } : {}),
    ...(metadata?.amount ? { amount: metadata.amount } : {}),
    ...(metadata?.providerRef ? { providerRef: metadata.providerRef } : {}),
    ...(metadata?.batteryId ? { batteryId: metadata.batteryId } : {}),
    ...(metadata?.slotId ? { slotId: metadata.slotId } : {}),
    ...(metadata?.station ? { stationCode: metadata.station } : {}),
    ...(metadata?.stationId ? { returnStationId: metadata.stationId } : {}),
    ...(metadata?.failureNote ? { failureReason: metadata.failureNote } : {}),
    ...(metadata?.error ? { lastError: metadata.error } : {}),
  });
}
