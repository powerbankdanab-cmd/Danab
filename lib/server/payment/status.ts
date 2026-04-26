import { HttpError } from "@/lib/server/payment/errors";
import {
  completePhase2Transaction,
  getPaymentTransaction,
  patchPaymentTransaction,
  transitionPaymentTransactionState,
  PAYMENT_TRANSACTIONS_COLLECTION,
  PaymentTransactionRecord,
} from "@/lib/server/payment/transactions";
import { checkPaymentStatusDetailed, extractWaafiIds, cancelWaafiPreauthorization } from "@/lib/server/payment/waafi";
import { finalizeCapture, cancelHold } from "@/lib/server/payment/process-payment";
import { getDb } from "@/lib/server/firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { releaseBattery, queryStationBatteries } from "@/lib/server/payment/heycharge";
import { normalizeBatteryId } from "@/lib/server/payment/battery-id";
import { verifyDeliveryWithConfidence } from "@/lib/server/payment/delivery-verification";
import { logError } from "@/lib/server/alerts/log-error";

const PAYMENT_PENDING_TIMEOUT_MS = 3 * 60_000;
const PROCESSING_TIMEOUT_MS = 30_000;
const CONFIRM_REQUIRED_TIMEOUT_MS = 120_000;

export type PaymentStatusResponse = {
  status:
  | "pending_payment"
  | "paid"
  | "processing"
  | "verifying"
  | "confirm_required"
  | "verified"
  | "capture_in_progress"
  | "captured"
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
  | "INVALID_INITIAL_STATE";
  failureReason?:
  | "USER_CANCELLED"
  | "INSUFFICIENT_FUNDS"
  | "PROVIDER_DECLINED"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "UNLOCK_FAILED"
  | "UNLOCK_TIMEOUT"
  | "VERIFICATION_FAILED"
  | "SLA_BREACH"
  | "INVALID_INITIAL_STATE";
  unlockStarted?: boolean;
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
      return code as PaymentStatusResponse["reason_code"];
    default:
      return undefined;
  }
}

async function getBatteryPresence(
  imei: string,
  batteryId: string,
  slotId: string,
): Promise<"present" | "missing" | "unknown"> {
  try {
    const stationBatteries = await queryStationBatteries(imei);
    const found = stationBatteries.find(
      (battery) =>
        normalizeBatteryId(battery.battery_id) === normalizeBatteryId(batteryId) &&
        battery.slot_id === slotId,
    );

    return found ? "present" : "missing";
  } catch (error) {
    await logError({
      type: "STATION_QUERY_FAILED",
      message: "Failed to query initial battery presence before unlock",
      metadata: {
        imei,
        batteryId,
        slotId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return "unknown";
  }
}

function toMillis(value: unknown): number | null {
  if (!value) return null;

  if (typeof value === "number") return value;

  if (value instanceof Date) return value.getTime();

  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }

  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { seconds?: unknown }).seconds === "number"
  ) {
    return (value as { seconds: number }).seconds * 1000;
  }

  return null;
}

function buildStatusResponse(
  transaction: PaymentTransactionRecord,
): PaymentStatusResponse {
  if (transaction.status === "failed") {
    return {
      status: "failed",
      reason_code: toReasonCode(transaction.failureReason),
      failureReason: toReasonCode(transaction.failureReason),
    };
  }

  if (transaction.status === "processing") {
    return { status: "processing" };
  }

  if (transaction.status === "verifying") {
    return { status: "verifying" };
  }

  if (transaction.status === "confirm_required") {
    return { status: "confirm_required" };
  }

  if (
    transaction.status === "verified" ||
    transaction.status === "capture_in_progress" ||
    transaction.status === "captured"
  ) {
    return { status: "verified" };
  }

  if (transaction.status === "paid") {
    return { status: "paid" };
  }

  return { status: "pending_payment" };
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
    await logError({
      type: "VERIFICATION_TIMEOUT",
      transactionId: transaction.id,
      stationCode: transaction.delivery.stationCode,
      phoneNumber: transaction.delivery.requestedPhoneNumber,
      message: "Background verification failed while resolving confirm_required",
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      },
    });

    const elapsedMs = Date.now() - confirmRequiredAtMs;
    if (elapsedMs >= CONFIRM_REQUIRED_TIMEOUT_MS) {
      await logError({
        type: "verification_final_check_failed",
        transactionId: transaction.id,
        stationCode: transaction.delivery.stationCode,
        message: "Final confirm_required verification attempt failed due to system error",
        metadata: { elapsedMs },
      });
      await cancelHold(transaction.id, "Confirmation timed out (final verification failed)");
      return { status: "failed", reason_code: "TIMEOUT", failureReason: "TIMEOUT" };
    }

    return { status: "confirm_required" };
  }

  if (verification.confidence === "HIGH") {
    await logError({
      type: "verification_recovered",
      transactionId: transaction.id,
      stationCode: transaction.delivery.stationCode,
      message: "Confirm_required transaction recovered with HIGH verification",
      metadata: {
        unlockStartedAt,
        missingDetectedAt: verification.missingDetectedAt,
      },
    });

    await finalizeCapture(transaction.id);
    const refreshed = await getPaymentTransaction(transaction.id);
    if (!refreshed) {
      throw new HttpError(404, "Transaction not found");
    }

    return buildStatusResponse(refreshed);
  }

  const elapsedMs = Date.now() - confirmRequiredAtMs;
  if (elapsedMs >= CONFIRM_REQUIRED_TIMEOUT_MS) {
    await logError({
      type: "verification_final_check_failed",
      transactionId: transaction.id,
      stationCode: transaction.delivery.stationCode,
      message: "Confirm_required final verification attempt did not reach HIGH confidence",
      metadata: {
        elapsedMs,
        confidence: verification.confidence,
      },
    });

    await cancelHold(transaction.id, "Confirmation timed out (final verification failed)");
    return { status: "failed", reason_code: "TIMEOUT", failureReason: "TIMEOUT" };
  }

  return { status: "confirm_required" };
}

export async function runUnlockIfNeeded(
  transaction: PaymentTransactionRecord,
): Promise<void> {
  if (transaction.status !== "paid" || transaction.unlockStarted) {
    return;
  }

  if (!transaction.delivery) {
    console.error("unable_to_start_unlock_flow", {
      transactionId: transaction.id,
      reason: "missing_delivery_payload",
    });
    return;
  }

  const initialPresence = await getBatteryPresence(
    transaction.delivery.imei,
    transaction.delivery.batteryId,
    transaction.delivery.slotId,
  );

  if (initialPresence !== "present") {
    console.error("unlock_invalid_initial_state", {
      transactionId: transaction.id,
      initialPresence,
      delivery: transaction.delivery,
    });

    await patchPaymentTransaction({
      id: transaction.id,
      patch: {
        status: "failed",
        failureReason: "INVALID_INITIAL_STATE",
        updatedAt: Date.now(),
        updatedAtTs: Timestamp.now(),
      },
    });

    return;
  }

  const db = getDb();
  const docRef = db
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .doc(transaction.id);

  let shouldUnlock = false;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new HttpError(404, "Transaction not found");
    }

    const fresh = snap.data() as PaymentTransactionRecord;
    if (fresh.status !== "paid" || fresh.unlockStarted) {
      return;
    }

    tx.update(docRef, {
      unlockStarted: true,
      status: "processing",
      processingStartedAt: new Date(),
      updatedAt: Date.now(),
      updatedAtTs: Timestamp.now(),
    });

    shouldUnlock = true;
  });

  if (!shouldUnlock) {
    return;
  }

  console.info("unlock_started", { transactionId: transaction.id });

  try {
    await releaseBattery({
      imei: transaction.delivery.imei,
      batteryId: transaction.delivery.batteryId,
      slotId: transaction.delivery.slotId,
    });

    await patchPaymentTransaction({
      id: transaction.id,
      patch: {
        status: "verifying",
        updatedAt: Date.now(),
        updatedAtTs: Timestamp.now(),
      },
    });
  } catch (error) {
    console.error("unlock_failed", {
      transactionId: transaction.id,
      error: error instanceof Error ? error.message : String(error),
    });

    await patchPaymentTransaction({
      id: transaction.id,
      patch: {
        status: "failed",
        failureReason: "UNLOCK_FAILED",
        updatedAt: Date.now(),
        updatedAtTs: Timestamp.now(),
      },
    });
  }
}

export async function getProviderDrivenPaymentStatus(
  transactionId: string,
): Promise<PaymentStatusResponse> {
  const transaction = await getPaymentTransaction(transactionId);

  if (!transaction) {
    throw new HttpError(404, "Transaction not found");
  }

  if (transaction.status === "paid") {
    if (!transaction.unlockStarted) {
      console.info("unlock_fallback_triggered", {
        transactionId,
      });

      runUnlockIfNeeded(transaction).catch((err) => {
        console.error("unlock_fallback_failed", {
          transactionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return buildStatusResponse(transaction);
  }

  if (transaction.status === "processing") {
    const processingStartedAtMs = toMillis(transaction.processingStartedAt);
    if (
      processingStartedAtMs !== null &&
      Date.now() - processingStartedAtMs > PROCESSING_TIMEOUT_MS
    ) {
      await transitionPaymentTransactionState({
        id: transactionId,
        from: "processing",
        to: "failed",
        patch: {
          failureReason: "UNLOCK_TIMEOUT",
        },
      });

      console.error("unlock_timeout", { transactionId });
      console.info("payment_failed", {
        transactionId,
        failureReason: "UNLOCK_TIMEOUT",
      });

      return {
        status: "failed",
        reason_code: "UNLOCK_TIMEOUT",
        failureReason: "UNLOCK_TIMEOUT",
      };
    }

    return buildStatusResponse(transaction);
  }

  if (transaction.status === "confirm_required") {
    return await handleConfirmRequiredStatus(transaction);
  }

  if (transaction.status === "verifying") {
    return buildStatusResponse(transaction);
  }

  if (transaction.status === "verified") {
    return buildStatusResponse(transaction);
  }

  if (transaction.status === "failed") {
    return buildStatusResponse(transaction);
  }

  let providerRefToUse = transaction.providerRef;
  let providerReferenceId: string | null = null;

  if (!providerRefToUse) {
    console.warn("MISSING providerRef - attempting fallback recovery via transactionId", {
      transactionId,
    });
    providerReferenceId = transactionId;
  }

  const providerCheck = await checkPaymentStatusDetailed(
    providerRefToUse,
    providerReferenceId,
  );

  if (!providerRefToUse && providerCheck.raw && providerCheck.status !== "unknown") {
    const recoveredIds = extractWaafiIds(providerCheck.raw);
    if (recoveredIds.transactionId) {
      console.error("CRITICAL_ORPHAN_HOLD_RECOVERED", {
        transactionId,
        recoveredProviderRef: recoveredIds.transactionId,
      });
      await patchPaymentTransaction({
        id: transaction.id,
        patch: { providerRef: recoveredIds.transactionId },
      });
      providerRefToUse = recoveredIds.transactionId;
    }
  }

  const createdAtMs = toMillis(transaction.createdAt);
  if (!createdAtMs) {
    console.error("MISSING createdAt - cannot evaluate timeout", {
      transactionId,
      createdAt: transaction.createdAt,
    });
  } else {
    const elapsedMs = Date.now() - createdAtMs;
    
    if (
      transaction.status === "pending_payment" &&
      elapsedMs >= PAYMENT_PENDING_TIMEOUT_MS
    ) {
      if (providerRefToUse && (providerCheck.status === "pending" || providerCheck.status === "paid")) {
        console.error("CRITICAL_TIMEOUT_CANCEL: Cancelling orphaned provider hold due to timeout", { transactionId, providerRefToUse });
        try {
          await cancelWaafiPreauthorization({
            transactionId: providerRefToUse,
            description: "Payment pending_payment timed out",
          });
        } catch (e) {
          console.error("Failed to cancel orphan hold on timeout", e);
        }
      }

      const status = await completePhase2Transaction({
        id: transactionId,
        status: "failed",
        failureReason: "TIMEOUT",
      });

      console.info("payment_failed", {
        transactionId,
        failureReason: "TIMEOUT",
      });

      return { status, reason_code: "TIMEOUT", failureReason: "TIMEOUT" };
    }
  }

  if (!providerRefToUse) {
    const createdAtMs = toMillis(transaction.createdAt);

    if (createdAtMs && Date.now() - createdAtMs > 30_000) {
      console.error("ORPHAN_PAYMENT_DETECTED", {
        transactionId,
        phone: transaction.phone,
      });

      await completePhase2Transaction({
        id: transactionId,
        status: "failed",
        failureReason: "PROVIDER_ERROR",
      });

      return {
        status: "failed",
        reason_code: "PROVIDER_ERROR",
        failureReason: "PROVIDER_ERROR",
      };
    }

    return { status: "pending_payment" };
  }

  console.info("payment_status_checked", {
    transactionId,
    providerRef: providerRefToUse,
    providerStatus: providerCheck.status,
    providerResponseCode:
      providerCheck.raw?.responseCode !== undefined
        ? String(providerCheck.raw?.responseCode)
        : null,
    providerErrorCode: providerCheck.raw?.errorCode || null,
    providerState: providerCheck.raw?.params?.state || null,
    providerMessage: providerCheck.raw?.responseMsg || null,
  });

  if (providerCheck.error) {
    console.info("provider_error", {
      transactionId,
      providerRef: transaction.providerRef,
      error: providerCheck.error,
    });

    return { status: "pending_payment" };
  }

  if (providerCheck.status === "cancelled" || providerCheck.status === "failed") {
    const reason = providerCheck.reason || "PROVIDER_ERROR";
    
    const status = await completePhase2Transaction({
      id: transactionId,
      status: "failed",
      failureReason: reason,
    });

    console.info(`payment_${providerCheck.status}`, {
      transactionId,
      failureReason: reason,
    });

    return {
      status,
      reason_code: reason,
      failureReason: reason,
    };
  }

  if (providerCheck.status === "paid") {
    await completePhase2Transaction({
      id: transactionId,
      status: "paid",
    });

    console.info("payment_paid", { transactionId });

    const updatedTransaction = await getPaymentTransaction(transactionId);
    if (!updatedTransaction) {
      throw new HttpError(404, "Transaction not found");
    }

    return buildStatusResponse(updatedTransaction);
  }

  return { status: "pending_payment" };
}
