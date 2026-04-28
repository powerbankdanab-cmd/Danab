import { HttpError } from "@/lib/server/payment/errors";
import {
  completePhase2Transaction,
  getPaymentTransaction,
  patchPaymentTransaction,
  transitionPaymentTransactionState,
  PAYMENT_TRANSACTIONS_COLLECTION,
  PaymentTransactionRecord,
  logTransactionEvent,
  toMillis,
  markUnlockStarted,
  markTransactionCancelPending,
} from "@/lib/server/payment/transactions";
import { checkPaymentStatusDetailed, extractWaafiIds, cancelWaafiPreauthorization } from "@/lib/server/payment/waafi";
import { finalizeCapture, cancelHold, performEjectionAndVerification } from "@/lib/server/payment/process-payment";
import { getDb } from "@/lib/server/firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { verifyDeliveryWithConfidence } from "@/lib/server/payment/delivery-verification";
import { logError, CRITICAL_ERROR_TYPES } from "@/lib/server/alerts/log-error";
import { getAvailableBattery } from "@/lib/server/payment/heycharge";
import { reserveBattery } from "@/lib/server/payment/battery-lock";
import { getStationConfigByCode } from "@/lib/server/station-config";

const PAYMENT_PENDING_TIMEOUT_MS = 3 * 60_000;
const PROCESSING_TIMEOUT_MS = 30_000;
const CONFIRM_REQUIRED_TIMEOUT_MS = 120_000;

export type PaymentStage = "payment" | "unlock" | "verification" | "capture" | "system";

export type PaymentStatusResponse = {
  status:
  | "pending_payment"
  | "held"
  | "paid"
  | "processing"
  | "verifying"
  | "confirm_required"
  | "verified"
  | "capture_in_progress"
  | "captured"
  | "partial_success"
  | "failed";
  reason_code?:
  | "USER_CANCELLED"
  | "INSUFFICIENT_FUNDS"
  | "PROVIDER_DECLINED"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "UNLOCK_FAILED"
  | "UNLOCK_TIMEOUT"
  | "VERIFICATION_FAILED"
  | "SLA_BREACH"
  | "INVALID_INITIAL_STATE"
  | "STATION_OFFLINE";
  stage?: PaymentStage | "system";
  unlockStarted?: boolean;
  recovered?: boolean;
  error?: string;
};

function toReasonCode(
  failureReason: unknown,
): PaymentStatusResponse["reason_code"] {
  const code = String(failureReason).trim().toUpperCase();

  switch (code) {
    case "USER_CANCELLED":
    case "INSUFFICIENT_FUNDS":
    case "PROVIDER_DECLINED":
    case "PROVIDER_ERROR":
    case "TIMEOUT":
    case "UNLOCK_FAILED":
    case "UNLOCK_TIMEOUT":
    case "VERIFICATION_FAILED":
    case "SLA_BREACH":
    case "INVALID_INITIAL_STATE":
    case "STATION_OFFLINE":
      return code as PaymentStatusResponse["reason_code"];
    default:
      return undefined;
  }
}

function inferStage(
  reasonCode: PaymentStatusResponse["reason_code"],
  storedStage?: string | null,
): PaymentStage {
  if (
    storedStage === "payment" ||
    storedStage === "unlock" ||
    storedStage === "verification" ||
    storedStage === "capture"
  ) {
    return storedStage;
  }

  switch (reasonCode) {
    case "USER_CANCELLED":
    case "INSUFFICIENT_FUNDS":
    case "PROVIDER_DECLINED":
    case "PROVIDER_ERROR":
    case "TIMEOUT":
    case "STATION_OFFLINE":
      return "payment";
    case "UNLOCK_FAILED":
    case "UNLOCK_TIMEOUT":
    case "INVALID_INITIAL_STATE":
      return "unlock";
    case "VERIFICATION_FAILED":
      return "verification";
    case "SLA_BREACH":
      return "verification";
    default:
      return "payment";
  }
}

function buildStatusResponse(
  transaction: PaymentTransactionRecord,
): PaymentStatusResponse {
  const recovered = (transaction.recoveryAttempts ?? 0) > 0;

  // Terminal States (Failures)
  if (transaction.status === "failed" || transaction.status === "cancel_pending") {
    const reasonCode = toReasonCode(transaction.failureReason);
    let stage = inferStage(reasonCode, transaction.failureStage);
    
    if (!stage) {
      logError({
        type: "INVARIANT_VIOLATION",
        transactionId: transaction.id,
        message: "Failure response requested but stage is missing. Falling back to system stage.",
      });
      stage = "system";
    }

    const isPartialSuccess =
      stage === "unlock" &&
      (reasonCode === "UNLOCK_FAILED" || reasonCode === "UNLOCK_TIMEOUT");

    // partial_success ONLY if we have a guarantee that funds are not captured
    // In our system, this is represented by status being held (pre-failure) 
    // or actively being cancelled (cancel_pending) or marked failed after cancel.
    if (isPartialSuccess && transaction.status !== "cancel_pending" && !transaction.failedAt) {
      logError({
        type: "INVARIANT_VIOLATION",
        transactionId: transaction.id,
        message: "Partial success claimed but no cancellation guarantee found. Downgrading to failed.",
      });
      return {
        status: "failed",
        reason_code: "PROVIDER_ERROR",
        stage: "system",
        recovered,
        error: "System consistency check failed",
      };
    }

    return {
      status: isPartialSuccess ? "partial_success" : "failed",
      reason_code: reasonCode,
      stage,
      recovered,
      error:
        String(transaction.failureReason || "").trim() ||
        (reasonCode ? `Failure: ${reasonCode}` : "Payment failed"),
    };
  }

  // Active States
  if (transaction.status === "processing") {
    return { status: "processing", stage: "unlock", recovered };
  }

  if (transaction.status === "verifying") {
    return { status: "verifying", stage: "verification", recovered };
  }

  if (transaction.status === "confirm_required") {
    return { status: "confirm_required", stage: "verification", recovered };
  }

  if (
    transaction.status === "verified" ||
    transaction.status === "capture_in_progress" ||
    transaction.status === "captured"
  ) {
    return { 
      status: transaction.status === "captured" ? "captured" : "verified", 
      stage: transaction.status === "captured" ? "capture" : "verification", 
      recovered 
    };
  }

  if (transaction.status === "held" || transaction.status === "paid") {
    return { 
      status: "held", 
      stage: transaction.unlockStarted ? "unlock" : "payment", 
      recovered 
    };
  }

  return { status: "pending_payment", stage: "payment", recovered };
}

/**
 * PURE READ ONLY PATH for UI polling.
 */
export async function getProviderDrivenPaymentStatus(
  transactionId: string,
): Promise<PaymentStatusResponse> {
  const transaction = await getPaymentTransaction(transactionId);

  if (!transaction) {
    throw new HttpError(404, "Transaction not found");
  }

  return buildStatusResponse(transaction);
}

/**
 * Atomic and idempotent trigger for the hardware unlock process.
 */
export async function triggerUnlockIfNeeded(
  transactionId: string,
): Promise<{ started: boolean; attempt?: number; reason?: string }> {
  // 1. Atomic Guard: Attempt to mark the transaction as started.
  // This uses a database transaction internally to prevent race conditions.
  const result = await markUnlockStarted(transactionId);

  if (result === "ALREADY_COMPLETED") return { started: false, reason: "ALREADY_COMPLETED" };
  if (result === "ALREADY_FAILED") return { started: false, reason: "ALREADY_FAILED" };
  if (result === "MAX_RETRIES_EXCEEDED") {
    console.error("unlock_max_retries_exceeded", { transactionId });
    return { started: false, reason: "MAX_RETRIES_EXCEEDED" };
  }

  // Fetch the fresh transaction record
  const refreshed = await getPaymentTransaction(transactionId);
  if (!refreshed) return { started: false, reason: "NOT_FOUND" };

  if (result === "ALREADY_STARTED") {
    return {
      started: true,
      attempt: refreshed.unlockRetryCount || 0,
      reason: "ALREADY_STARTED"
    };
  }

  // 1.5. Station Health Invariant: Don't unlock if station is dead
  if (refreshed.station) {
    const healthy = await isStationHealthy(refreshed.station);
    if (!healthy) {
      await logError({
        type: "STATION_HEALTH_FAILURE",
        transactionId: refreshed.id,
        message: "Station health check failed before unlock. Cancelling.",
        metadata: { stationCode: refreshed.station }
      });

      await markTransactionCancelPending(transactionId, "Station unhealthy before unlock");
      return { started: false, reason: "STATION_OFFLINE" };
    }
  }

  // 2. Execution Guarantee: Trigger the hardware
  try {
    if (!refreshed.delivery) {
       // Attempt to repair delivery context if missing
       const delivery = await ensureDeliveryContext(refreshed);
       if (!delivery) {
         throw new Error("Missing delivery context for unlock and repair failed");
       }
       refreshed.delivery = delivery;
    }

    await performEjectionAndVerification({
      idempotencyKey: refreshed.id,
      transactionId: refreshed.providerRef || "UNKNOWN",
      stationCode: refreshed.delivery.stationCode,
      phoneNumber: refreshed.delivery.requestedPhoneNumber,
      imei: refreshed.delivery.imei,
      battery: {
        battery_id: refreshed.delivery.batteryId,
        slot_id: refreshed.delivery.slotId,
      },
      preauthAudit: refreshed.waafiAudit as Record<string, unknown>,
      phoneAuthority: refreshed.delivery.phoneAuthority,
      canonicalPhoneNumber: refreshed.delivery.canonicalPhoneNumber,
    });

    return {
      started: true,
      attempt: refreshed.unlockRetryCount || 1
    };
  } catch (error) {
    await logError({
      type: "UNLOCK_TRIGGER_FAILED",
      transactionId: refreshed.id,
      message: "Failed to perform unlock and verification from execution path",
      metadata: {
        status: refreshed.status,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    return {
      started: false,
      attempt: refreshed.unlockRetryCount || 0,
      reason: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    };
  }
}

/**
 * Reconciles the transaction state by checking the provider and hardware status.
 * This function has side effects and should be called by workers or explicit trigger routes.
 */
export async function reconcileTransactionStatus(
  transactionId: string,
): Promise<PaymentStatusResponse> {
  const transaction = await getPaymentTransaction(transactionId);
  if (!transaction) throw new HttpError(404, "Transaction not found");

  // 1. Handle hardware verification if in confirm_required state
  if (transaction.status === "confirm_required") {
    return await handleConfirmRequiredStatus(transaction);
  }

  // 2. Handle payment provider verification if in pending_payment state
  if (transaction.status === "pending_payment") {
    return await performProviderReconciliation(transaction);
  }

  // 3. Handle stuck 'paid' state (transition to 'held')
  if (transaction.status === "paid") {
     if (!transaction.delivery) {
        await ensureDeliveryContext(transaction);
     }
     
     try {
       await transitionPaymentTransactionState({
         id: transaction.id,
         from: "paid",
         to: "held",
         patch: { heldAt: Date.now() },
       });
       const updated = await getPaymentTransaction(transactionId);
       return buildStatusResponse(updated || transaction);
     } catch (e) {
       // Conflict or error
     }
  }

  return buildStatusResponse(transaction);
}

async function handleConfirmRequiredStatus(
  transaction: PaymentTransactionRecord,
): Promise<PaymentStatusResponse> {
  if (!transaction.delivery) {
    return { status: "confirm_required" };
  }

  const CONFIRM_REQUIRED_REVERIFY_INTERVAL_MS = 3000;
  const confirmRequiredAtMs = toMillis(
    transaction.confirmRequiredAt ?? transaction.updatedAt,
  ) ?? Date.now();
  const lastReverifyAtMs = toMillis(transaction.lastConfirmVerificationAt) ?? 0;

  if (Date.now() - lastReverifyAtMs < CONFIRM_REQUIRED_REVERIFY_INTERVAL_MS) {
    return { status: "confirm_required" };
  }

  const unlockStartedAt =
    transaction.delivery.unlockStartedAt ??
    toMillis(transaction.processingStartedAt) ??
    Date.now();

  await patchPaymentTransaction({
    id: transaction.id,
    patch: {
      lastConfirmVerificationAt: Date.now(),
    },
  });

  let verification;
  try {
    verification = await verifyDeliveryWithConfidence(
      transaction.delivery.imei,
      transaction.delivery.batteryId,
      transaction.delivery.slotId,
      {
        stationCode: transaction.delivery.stationCode,
        phoneNumber: transaction.delivery.requestedPhoneNumber,
        transactionId: transaction.id,
      },
      unlockStartedAt,
    );
  } catch (error) {
    const elapsedMs = Date.now() - confirmRequiredAtMs;
    if (elapsedMs >= CONFIRM_REQUIRED_TIMEOUT_MS) {
      await cancelHold(transaction.id, "Confirmation timed out (final verification failed)");
      return { status: "failed", reason_code: "TIMEOUT", stage: "verification" };
    }
    return { status: "confirm_required" };
  }

  if (verification.confidence === "HIGH") {
    await finalizeCapture(transaction.id);
    const refreshed = await getPaymentTransaction(transaction.id);
    return buildStatusResponse(refreshed || transaction);
  }

  const elapsedMs = Date.now() - confirmRequiredAtMs;
  if (elapsedMs >= CONFIRM_REQUIRED_TIMEOUT_MS) {
    await cancelHold(transaction.id, "Confirmation timed out (final verification failed)");
    return { status: "failed", reason_code: "TIMEOUT", stage: "verification" };
  }

  return { status: "confirm_required" };
}

async function performProviderReconciliation(
  transaction: PaymentTransactionRecord,
): Promise<PaymentStatusResponse> {
  const transactionId = transaction.id;
  let providerRefToUse = transaction.providerRef;
  let providerReferenceId: string | null = null;

  if (!providerRefToUse) {
    providerReferenceId = transactionId;
  }

  const providerCheck = await checkPaymentStatusDetailed(
    providerRefToUse,
    providerReferenceId,
  );

  if (!providerRefToUse && providerCheck.raw && providerCheck.status !== "unknown") {
    const recoveredIds = extractWaafiIds(providerCheck.raw);
    if (recoveredIds.transactionId) {
      await patchPaymentTransaction({
        id: transaction.id,
        patch: { providerRef: recoveredIds.transactionId },
      });
      providerRefToUse = recoveredIds.transactionId;
    }
  }

  const createdAtMs = toMillis(transaction.createdAt);
  if (createdAtMs) {
    const elapsedMs = Date.now() - createdAtMs;

    if (elapsedMs >= PAYMENT_PENDING_TIMEOUT_MS) {
      if (providerCheck.status === "paid") return { status: "pending_payment" };

      if (providerRefToUse && providerCheck.status === "pending") {
        try {
          await cancelWaafiPreauthorization({
            transactionId: providerRefToUse,
            description: "Payment pending_payment timed out",
          });
        } catch (e) {}
      }

      const status = await completePhase2Transaction({
        id: transactionId,
        status: "failed",
        failureReason: "TIMEOUT",
        failureStage: "payment",
      });

      return { status, reason_code: "TIMEOUT", stage: "payment" };
    }
  }

  if (providerCheck.status === "cancelled" || providerCheck.status === "failed") {
    const reason = (providerCheck.reason || "PROVIDER_ERROR") as PaymentStatusResponse["reason_code"];
    const resolvedStage = inferStage(reason);

    const status = await completePhase2Transaction({
      id: transactionId,
      status: "failed",
      failureReason: reason,
      failureStage: resolvedStage,
    });

    return { status, reason_code: reason, stage: resolvedStage };
  }

  if (providerCheck.status === "paid") {
    await completePhase2Transaction({
      id: transactionId,
      status: "paid",
    });

    const updatedTransaction = await getPaymentTransaction(transactionId);
    return buildStatusResponse(updatedTransaction || transaction);
  }

  return { status: "pending_payment" };
}

export async function ensureDeliveryContext(
  transaction: Pick<PaymentTransactionRecord, "id" | "station" | "phone" | "status" | "delivery">
): Promise<PaymentTransactionRecord["delivery"] | null> {
  if (transaction.delivery) return transaction.delivery;
  if (!transaction.station) return null;

  const stationConfig = getStationConfigByCode(transaction.station);
  if (!stationConfig) return null;

  try {
    const battery = await getAvailableBattery(stationConfig.imei);
    if (!battery) return null;

    const reserved = await reserveBattery(stationConfig.imei, battery.battery_id, transaction.phone);
    if (!reserved) return null;

    const delivery = {
      imei: stationConfig.imei,
      stationCode: transaction.station,
      batteryId: battery.battery_id,
      slotId: battery.slot_id,
      phoneAuthority: "requested_phone_only",
      unlockAttempts: 0,
      requestedPhoneNumber: transaction.phone,
      canonicalPhoneNumber: transaction.phone,
    };

    await patchPaymentTransaction({
      id: transaction.id,
      patch: { delivery, updatedAt: Date.now() },
    });

    return delivery;
  } catch (error) {
    console.error("ensureDeliveryContext_failed", { transactionId: transaction.id, error });
    return null;
  }
}

export async function isStationHealthy(stationCode: string): Promise<boolean> {
  const db = (await import("@/lib/server/firebase-admin")).getDb();
  const now = Date.now();
  const threshold = now - (15 * 60 * 1000); // 15 mins

  const config = getStationConfigByCode(stationCode);
  if (!config) return false;

  try {
    const recentFailuresSnap = await db.collection("errors")
      .where("stationCode", "==", stationCode)
      .where("createdAt", ">", threshold)
      .where("type", "==", CRITICAL_ERROR_TYPES.VERIFICATION_FAILED)
      .limit(3)
      .get();

    if (recentFailuresSnap.size >= 3) return false;
    return true;
  } catch (error) {
    return true;
  }
}
