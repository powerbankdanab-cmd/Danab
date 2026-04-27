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

  if (transaction.status === "held") {
    return { status: "paid" };
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

export async function triggerUnlockIfNeeded(
  transaction: PaymentTransactionRecord,
): Promise<void> {
  // If already finished or failed, nothing to do
  if (transaction.unlockCompleted || transaction.unlockFailed) {
    return;
  }

  // Phase 5: Station Health Protection
  if (transaction.delivery?.stationCode) {
    const healthy = await isStationHealthy(transaction.delivery.stationCode);
    if (!healthy) {
       await logError({
         type: CRITICAL_ERROR_TYPES.DELIVERY_VERIFICATION,
         transactionId: transaction.id,
         stationCode: transaction.delivery.stationCode,
         message: "Station blacklisted due to recent failures. Skipping unlock attempt.",
       });
       // Do not auto-cancel yet, let reconciliation handle or manual repair
       return;
    }
  }

  // If already started but not finished, we check if we should resume (e.g. after crash)
  if (transaction.unlockStarted) {
     const age = Date.now() - toMillis(transaction.processingStartedAt || transaction.updatedAt)!;
     if (age < 15_000) { // 15s cooldown before resuming a 'started' unlock
       return;
     }
     
     await logTransactionEvent(transaction.id, "AUTO_RESUME_UNLOCK_RECOVERY", {
       reason: "Transaction was started but not completed/failed",
       ageMs: age
     }, "IMPORTANT");
  }

  if (transaction.status !== "paid" && transaction.status !== "held") {
    return;
  }

  if (!transaction.providerRef) {
    console.error("invalid_held_state: missing providerRef", {
      transactionId: transaction.id,
      status: transaction.status,
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

  // Repair delivery context if missing but station is known
  if (!transaction.delivery) {
    const delivery = await ensureDeliveryContext(transaction);
    if (!delivery) return;
    transaction.delivery = delivery;
  }

  if (transaction.status === "paid") {
    try {
      await transitionPaymentTransactionState({
        id: transaction.id,
        from: "paid",
        to: "held",
        patch: {
          heldAt: Date.now(),
        },
      });

      await logTransactionEvent(transaction.id, "HELD", {
        providerRef: transaction.providerRef,
        station: transaction.delivery.stationCode,
        batteryId: transaction.delivery.batteryId,
        slotId: transaction.delivery.slotId,
      }, "IMPORTANT");
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.status === 409
      ) {
        // Another worker or status check already progressed this transaction.
      } else {
        throw error;
      }
    }
  }

  const refreshed = await getPaymentTransaction(transaction.id);
  if (!refreshed || refreshed.unlockStarted || refreshed.status !== "held") {
    // Exactly-once guard: if already started or status changed, exit.
    return;
  }

  try {
    await performEjectionAndVerification({
      idempotencyKey: transaction.id,
      transactionId: transaction.providerRef,
      stationCode: transaction.delivery.stationCode,
      phoneNumber: transaction.delivery.requestedPhoneNumber,
      imei: transaction.delivery.imei,
      battery: {
        battery_id: transaction.delivery.batteryId,
        slot_id: transaction.delivery.slotId,
      },
      preauthAudit: transaction.waafiAudit as Record<string, unknown>,
      phoneAuthority: transaction.delivery.phoneAuthority,
      canonicalPhoneNumber: transaction.delivery.canonicalPhoneNumber,
    });
  } catch (error) {
    await logError({
      type: "UNLOCK_TRIGGER_FAILED",
      transactionId: transaction.id,
      message: "Failed to perform unlock and verification from held/paid recovery path",
      metadata: {
        status: transaction.status,
        error: error instanceof Error ? error.message : String(error),
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
  if (transaction.status === "paid" || transaction.status === "held") {
    const heldAtMs = toMillis(transaction.heldAt ?? transaction.updatedAt) ?? Date.now();
    const heldAgeMs = Date.now() - heldAtMs;

    if (!transaction.unlockStarted) {
      // SLA Boundary: 30 seconds for held state resolution
      if (heldAgeMs > 30_000) {
        await logTransactionEvent(transaction.id, "SLA_BREACH_HELD_STALL", {
          heldAgeMs,
          status: transaction.status,
        }, "CRITICAL");

        await logError({
          type: "HELD_STALL",
          transactionId,
          message: "Held transaction exceeded SLA and was still waiting for unlock",
          metadata: {
            heldAgeMs,
            unlockStarted: transaction.unlockStarted,
          },
        });

        await cancelHold(transaction.id, "Unlock timed out after held state SLA breach");
        return {
          status: "failed",
          reason_code: "UNLOCK_TIMEOUT",
          failureReason: "UNLOCK_TIMEOUT",
        };
      }

      console.info("unlock_fallback_triggered", {
        transactionId,
      });

      await triggerUnlockIfNeeded(transaction);
    } else if (transaction.status === "held" && heldAgeMs > 60_000) {
      // Secondary fallback for started but stuck in held
      return {
        status: "failed",
        reason_code: "UNLOCK_TIMEOUT",
        failureReason: "UNLOCK_TIMEOUT",
      };
    }

    const refreshed = await getPaymentTransaction(transactionId);
    return buildStatusResponse(refreshed || transaction);
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
    console.warn("FALLBACK_PROVIDER_LOOKUP_USED: Attempting recovery via transactionId (referenceId)", {
      transactionId,
    });
    providerReferenceId = transactionId;
  }

  await logTransactionEvent(transactionId, "STATUS_POLL_START", {
    providerRef: providerRefToUse,
    referenceId: providerReferenceId,
  }, "DEBUG");

  const providerCheck = await checkPaymentStatusDetailed(
    providerRefToUse,
    providerReferenceId,
  );

  await logTransactionEvent(transactionId, "STATUS_POLL_RESPONSE", {
    status: providerCheck.status,
    raw: providerCheck.raw,
  }, "DEBUG");

  if (!providerRefToUse && providerCheck.raw && providerCheck.status !== "unknown") {
    const recoveredIds = extractWaafiIds(providerCheck.raw);
    if (recoveredIds.transactionId) {
      await logTransactionEvent(transactionId, "PROVIDER_REF_RECOVERED", {
        recoveredId: recoveredIds.transactionId,
      }, "IMPORTANT");

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
      // If the provider already marked it as paid, we should NOT cancel it.
      // We should let the polling logic below handle the successful transition.
      if (providerCheck.status === "paid") {
        console.warn("TIMEOUT_PREEMPTED: Provider is PAID, skipping timeout failure", { transactionId });
        return { status: "pending_payment" };
      }

      if (providerRefToUse && providerCheck.status === "pending") {
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
    const elapsedMs = createdAtMs ? Date.now() - createdAtMs : 0;

    if (elapsedMs > 30_000) {
      if (transaction.missingProviderRef === true) {
        // SECOND TIMEOUT: After 3 minutes, we must terminate the state to avoid infinite pending.
        if (elapsedMs > 180_000) {
          console.error("UNRESOLVABLE_HOLD_TIMEOUT", { transactionId });

          await logError({
            type: "UNRESOLVABLE_HOLD",
            transactionId,
            message: "Hold likely created but transactionId never recovered after 180s",
            metadata: { phone: transaction.phone },
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

        await logTransactionEvent(transactionId, "PROTECTED_ORPHAN_PREVENTION_ACTIVE", {
          elapsedMs,
        });

        console.warn("PROTECTED_ORPHAN_PREVENTION: 30s threshold reached for missingProviderRef", {
          transactionId,
          phone: transaction.phone,
        });
        return { status: "pending_payment" };
      }

      await logTransactionEvent(transactionId, "ORPHAN_PAYMENT_DETECTED", {
        elapsedMs,
      });

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

    await logTransactionEvent(transactionId, "PROVIDER_FAILURE_DETECTED", {
      reason,
      raw: providerCheck.raw,
    });

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
    await logTransactionEvent(transactionId, "PROVIDER_PAID_DETECTED", {
      providerRef: providerRefToUse,
    });

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

/**
 * Ensures that a transaction has a delivery context.
 * If missing, it attempts to acquire a battery and slot from the specified station.
 */
export async function ensureDeliveryContext(
  transaction: Pick<PaymentTransactionRecord, "id" | "station" | "phone" | "status" | "delivery">
): Promise<PaymentTransactionRecord["delivery"] | null> {
  if (transaction.delivery) {
    return transaction.delivery;
  }

  if (!transaction.station) {
    return null;
  }

  const stationConfig = getStationConfigByCode(transaction.station);
  if (!stationConfig) {
    return null;
  }

  try {
    const battery = await getAvailableBattery(stationConfig.imei);
    if (!battery) {
      return null;
    }

    const reserved = await reserveBattery(stationConfig.imei, battery.battery_id, transaction.phone);
    if (!reserved) {
      return null;
    }

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
      patch: {
        delivery,
        updatedAt: Date.now(),
      },
    });

    await logTransactionEvent(transaction.id, "AUTO_REPAIR_DELIVERY_CONTEXT", {
      station: transaction.station,
      batteryId: battery.battery_id,
      slotId: battery.slot_id,
      reason: "Missing delivery context in held/paid state",
    }, "CRITICAL");

    return delivery;
  } catch (error) {
    console.error("ensureDeliveryContext_failed", {
      transactionId: transaction.id,
      error,
    });
    return null;
  }
}
export async function isStationHealthy(stationCode: string): Promise<boolean> {
  const db = (await import("@/lib/server/firebase-admin")).getDb();
  const now = Date.now();
  const threshold = now - (15 * 60 * 1000); // 15 mins

  try {
    const recentFailuresSnap = await db.collection("errors")
      .where("stationCode", "==", stationCode)
      .where("createdAt", ">", threshold)
      .where("type", "==", CRITICAL_ERROR_TYPES.VERIFICATION_FAILED)
      .limit(3)
      .get();

    // If 3+ ejection failures in 15 mins, consider station unhealthy
    return recentFailuresSnap.size < 3;
  } catch (err) {
    console.error("isStationHealthy_check_failed", { stationCode, err });
    return true; // Default to healthy to avoid false blocking
  }
}
