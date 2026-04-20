import {
  acquirePhonePaymentLock,
  releaseReservation,
  releasePhonePaymentLock,
  reserveBattery,
} from "@/lib/server/payment/battery-lock";
import { BatteryStateConflictError } from "@/lib/server/payment/battery-state";
import { normalizeBatteryId } from "@/lib/server/payment/battery-id";
import { HttpError } from "@/lib/server/payment/errors";
import {
  getAvailableBattery,
  markProblemSlot,
  MIN_AVAILABLE_BATTERY_PERCENT,
  queryStationBatteries,
  releaseBattery,
} from "@/lib/server/payment/heycharge";
import { isPhoneBlacklisted } from "@/lib/server/payment/blacklist";
import {
  createRentalLog,
  getRentalByTransactionId,
  hasActiveRentalForPhone,
  isDuplicateTransaction,
  updateRentalUnlockStatus,
} from "@/lib/server/payment/rentals";
import { getActiveStationCode, getStationImei } from "@/lib/server/payment/station";
import { getStationConfigByCode } from "@/lib/server/station-config";
import { notifyPaidButNotEjected } from "@/lib/server/payment/telegram";
import { PaymentInput, PaymentPayload } from "@/lib/server/payment/types";
import { CRITICAL_ERROR_TYPES, logError } from "@/lib/server/alerts/log-error";
import {
  createOrGetPaymentTransaction,
  ensurePaymentTransactionState,
  getPaymentTransaction,
  patchPaymentTransaction,
  transitionPaymentTransactionState,
  PaymentTransactionRecord,
} from "@/lib/server/payment/transactions";
import { reconcileTransactionById } from "@/lib/server/payment/reconciliation";
import {
  cancelWaafiPreauthorization,
  commitWaafiPreauthorization,
  extractWaafiAudit,
  extractWaafiIds,
  isWaafiApproved,
  mergeWaafiAuditRecords,
  requestWaafiPreauthorization,
} from "@/lib/server/payment/waafi";
import { verifyDeliveryWithConfidence } from "@/lib/server/payment/delivery-verification";
import {
  BatteryPresence,
  BatterySnapshot,
  DeliveryConfidence,
  VerificationResult
} from "@/lib/server/payment/types";

const MAX_UNLOCK_ATTEMPTS = 5;
const UNLOCK_RETRY_DELAY_MS = 2_000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBatterySnapshot(
  imei: string,
  batteryId: string,
  slotId: string,
): Promise<BatterySnapshot> {
  try {
    const stationBatteries = await queryStationBatteries(imei);
    const found = stationBatteries.find(
      (battery) =>
        normalizeBatteryId(battery.battery_id) === normalizeBatteryId(batteryId) &&
        battery.slot_id === slotId,
    );

    if (!found) {
      return {
        presence: "missing",
        lockStatus: null,
        slotStatus: null,
        batteryStatus: null,
        observedAt: Date.now(),
      };
    }

    return {
      presence: "present",
      lockStatus: found.lock_status || null,
      slotStatus: found.slot_status || null,
      batteryStatus: found.battery_status || null,
      observedAt: Date.now(),
    };
  } catch (error) {
    // Station query failure during verification polling — this is a critical
    // signal for inconsistent station state and must be logged structurally.
    await logError({
      type: "STATION_QUERY_FAILED",
      message: "Failed to query station batteries during verification polling",
      metadata: {
        imei,
        batteryId,
        slotId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return {
      presence: "unknown",
      lockStatus: null,
      slotStatus: null,
      batteryStatus: null,
      observedAt: Date.now(),
    };
  }
}


async function markTransactionFailed(
  transactionId: string,
  reason: string,
): Promise<void> {
  const tx = await getPaymentTransaction(transactionId);
  if (!tx) return;

  if (
    tx.status === "captured" ||
    tx.status === "capture_unknown" ||
    tx.status === "failed"
  ) {
    return;
  }

  await transitionPaymentTransactionState({
    id: transactionId,
    from: tx.status,
    to: "failed",
    patch: {
      failedAt: Date.now(),
      failureReason: reason,
    },
  });
}

export async function processPayment(
  input: PaymentInput,
): Promise<PaymentPayload> {
  const phoneNumber = input.phoneNumber.replace(/\D/g, "");
  const { amount } = input;
  const requestedStationCode = String(input.stationCode || "").replace(/\D/g, "");
  const idempotencyKey = String(input.idempotencyKey || "").trim();

  if (!idempotencyKey) {
    throw new HttpError(400, "Missing idempotency key");
  }

  const blacklisted = await isPhoneBlacklisted(phoneNumber);
  if (blacklisted) {
    throw new HttpError(
      403,
      "You are blocked from renting. Please contact support.",
    );
  }

  const requestedStationConfig = requestedStationCode
    ? getStationConfigByCode(requestedStationCode)
    : null;
  if (requestedStationCode && !requestedStationConfig) {
    throw new HttpError(400, "Invalid station code");
  }

  const imei = requestedStationConfig?.imei || (await getStationImei());
  const stationCode =
    requestedStationConfig?.code || (await getActiveStationCode());

  const txRecord = await createOrGetPaymentTransaction({
    id: idempotencyKey,
    phone: phoneNumber,
    station: stationCode,
    amount,
  });

  if (!txRecord.created) {
    if (txRecord.record.status === "captured") {
      if (!txRecord.record.rentalCreated) {
        try {
          await reconcileTransactionById(txRecord.record.id);
        } catch (error) {
          await logError({
            type: CRITICAL_ERROR_TYPES.RECONCILIATION_FAILED,
            transactionId: txRecord.record.providerRef || txRecord.record.id,
            stationCode,
            phoneNumber,
            message: "Failed to reconcile captured transaction on retry path",
            metadata: {
              idempotencyKey: txRecord.record.id,
              reason: error instanceof Error ? error.message : String(error),
            },
          });

          throw new HttpError(
            502,
            "Payment recovery failed while validating previous captured transaction.",
            {
              transactionId: txRecord.record.providerRef || txRecord.record.id,
            },
          );
        }
        const refreshed = await getPaymentTransaction(txRecord.record.id);
        if (!refreshed?.rentalCreated) {
          throw new HttpError(
            409,
            "Payment was captured and is being repaired. Please wait a moment and retry.",
            {
              transactionId: txRecord.record.id,
              status: txRecord.record.status,
            },
          );
        }
      }

      return {
        success: true,
        message: "Payment already processed",
        transactionId: txRecord.record.providerRef || txRecord.record.id,
      };
    }

    if (txRecord.record.status === "capture_unknown") {
      try {
        await reconcileTransactionById(txRecord.record.id);
      } catch (error) {
        await logError({
          type: CRITICAL_ERROR_TYPES.RECONCILIATION_FAILED,
          transactionId: txRecord.record.providerRef || txRecord.record.id,
          stationCode,
          phoneNumber,
          message: "Failed to reconcile capture_unknown transaction on retry path",
          metadata: {
            idempotencyKey: txRecord.record.id,
            reason: error instanceof Error ? error.message : String(error),
          },
        });

        throw new HttpError(
          502,
          "Payment reconciliation failed. Please try again shortly or contact support.",
          {
            transactionId: txRecord.record.providerRef || txRecord.record.id,
          },
        );
      }
      const refreshed = await getPaymentTransaction(txRecord.record.id);
      if (refreshed?.status === "captured" && refreshed.rentalCreated) {
        return {
          success: true,
          message: "Payment already processed",
          transactionId: refreshed.providerRef || refreshed.id,
        };
      }
      if (refreshed?.status === "failed") {
        throw new HttpError(409, "This payment attempt already failed.", {
          transactionId: refreshed.id,
          status: refreshed.status,
        });
      }

      throw new HttpError(409, "Payment state is under reconciliation.", {
        transactionId: txRecord.record.id,
        status: txRecord.record.status,
      });
    }

    if (txRecord.record.status === "failed") {
      throw new HttpError(409, "This payment attempt already failed.", {
        transactionId: txRecord.record.id,
        status: txRecord.record.status,
      });
    }

    throw new HttpError(
      409,
      "This payment is already being processed. Please wait.",
      {
        transactionId: txRecord.record.id,
        status: txRecord.record.status,
      },
    );
  }

  const phoneLockAcquired = await acquirePhonePaymentLock(phoneNumber);
  if (!phoneLockAcquired) {
    throw new HttpError(
      409,
      "A payment for this phone is already being processed. Please wait a moment before trying again.",
    );
  }

  let reservedBatteryId: string | null = null;
  let holdCreated = false;
  let holdTransactionId: string | null = null;

  try {
    const hasActiveRental = await hasActiveRentalForPhone(phoneNumber);
    if (hasActiveRental) {
      throw new HttpError(
        409,
        "You already have an active rental. Please return it before renting another battery.",
      );
    }

    // ── Atomic battery reservation ────────────────────────────────
    const MAX_RESERVE_ATTEMPTS = 3;
    let battery = null;

    for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
      const candidate = await getAvailableBattery(imei);
      if (!candidate) break;

      const reserved = await reserveBattery(
        imei,
        candidate.battery_id,
        phoneNumber,
      );
      if (reserved) {
        // Consolidated check: getAvailableBattery already verified readiness.
        battery = candidate;
        reservedBatteryId = candidate.battery_id;
        break;
      }
      await logError({
        type: "BATTERY_RESERVE_CONTENTION",
        stationCode,
        phoneNumber,
        message: `Reserve attempt ${attempt + 1}: battery ${candidate.battery_id} already taken, trying next`,
        metadata: {
          imei,
          batteryId: candidate.battery_id,
          attempt: attempt + 1,
        },
      });
    }

    if (!battery) {
      throw new HttpError(
        400,
        `No available battery ≥ ${MIN_AVAILABLE_BATTERY_PERCENT}%`,
      );
    }

    // ── Waafi hold first, then eject, then commit/cancel ─────────
    const preauthReferenceId = `ref-${Date.now()}`;
    let preauthResponse;

    try {
      preauthResponse = await requestWaafiPreauthorization({
        phoneNumber,
        amount,
        referenceId: preauthReferenceId,
      });
    } catch (error) {
      const isTimeout = error instanceof Error &&
        (error.message.includes("timed out") || error.message.includes("timeout"));

      if (isTimeout) {
        await transitionPaymentTransactionState({
          id: idempotencyKey,
          from: "initiated",
          to: "pending_payment",
          patch: {
            providerReferenceId: preauthReferenceId,
            pendingReason: "WAAFI_INIT_TIMEOUT",
            updatedAt: Date.now(),
          }
        });

        await logError({
          type: "ASYNC_PAYMENT_PENDING",
          transactionId: idempotencyKey,
          message: "Waafi preauthorization timed out - moved to pending_payment",
          metadata: { phoneNumber, amount, referenceId: preauthReferenceId }
        });

        return {
          status: "pending",
          message: "waiting_for_user_payment",
          transactionId: idempotencyKey
        };
      }
      throw error;
    }

    if (!isWaafiApproved(preauthResponse)) {
      // If it's not approved but NOT a timeout, we might still want to check if it's pending
      // based on Waafi response codes, but for now we follow the instruction:
      // "IF Waafi does not immediately confirm success -> move to pending_payment"
      // or at least handle the "waiting for user payment" UX.

      const responseCode = String(preauthResponse.responseCode);
      // Some providers use specific codes for "Pending/Processing"
      // If we are unsure, we move to pending_payment anyway to be safe.

      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "initiated",
        to: "pending_payment",
        patch: {
          providerReferenceId: preauthReferenceId,
          pendingReason: "WAAFI_NOT_IMMEDIATE_SUCCESS",
          waafiResponse: preauthResponse,
          updatedAt: Date.now(),
          delivery: {
            imei,
            stationCode,
            batteryId: reservedBatteryId,
            slotId: battery.slot_id,
            phoneNumber,
            // phoneAuthority and other fields can be updated later if needed
          }
        }
      });

      return {
        status: "pending",
        message: "waiting_for_user_payment",
        transactionId: idempotencyKey
      };
    }

    const { transactionId, issuerTransactionId, referenceId } =
      extractWaafiIds(preauthResponse);

    if (transactionId) {
      holdCreated = true;
      holdTransactionId = transactionId;
    }

    const preauthAudit = extractWaafiAudit(preauthResponse);
    const waafiConfirmedPhoneNumber =
      typeof preauthAudit.waafiConfirmedPhoneNumber === "string" &&
        preauthAudit.waafiConfirmedPhoneNumber.trim().length > 0
        ? preauthAudit.waafiConfirmedPhoneNumber.trim()
        : null;

    const canonicalPhoneNumber = phoneNumber;
    const phoneAuthority = waafiConfirmedPhoneNumber
      ? waafiConfirmedPhoneNumber === phoneNumber
        ? "waafi_confirmed_full_match"
        : "requested_phone_waafi_mismatch"
      : "requested_phone_only";

    if (!transactionId) {
      throw new HttpError(
        502,
        "Payment hold was approved, but Waafi did not return a transaction ID. Please try again.",
      );
    }

    try {
      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "initiated",
        to: "held",
        patch: {
          providerRef: transactionId,
          providerIssuerRef: issuerTransactionId,
          providerReferenceId: referenceId || preauthReferenceId,
          heldAt: Date.now(),
        },
      });
    } catch (stateError) {
      let cancelError: unknown = null;
      try {
        const cancelResponse = await cancelWaafiPreauthorization({
          transactionId,
          description: "Internal state sync failed after hold; hold cancelled",
        });
        holdTransactionId = null;
        if (!isWaafiApproved(cancelResponse)) {
          cancelError = new Error(
            cancelResponse.responseMsg || "Waafi cancel was not approved",
          );
        }
      } catch (error) {
        cancelError = error;
      }

      await markTransactionFailed(
        idempotencyKey,
        `Failed to persist held state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
      );

      await logError({
        type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: "Failed to persist held state after Waafi preauthorization",
        metadata: {
          idempotencyKey,
          stateError: stateError instanceof Error ? stateError.message : String(stateError),
          cancelAttempted: true,
          cancelFailed: !!cancelError,
          cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError ?? "none"),
        },
      });

      if (cancelError) {
        throw new HttpError(
          502,
          "Payment hold state was not persisted and hold cancellation could not be confirmed. Please contact support.",
          {
            transactionId,
          },
        );
      }

      throw new HttpError(
        502,
        "Payment hold state was not persisted. Hold was cancelled safely.",
        {
          transactionId,
        },
      );
    }

    const duplicate = await isDuplicateTransaction(transactionId);
    if (duplicate) {
      let duplicateCancelFailed = false;
      try {
        await cancelWaafiPreauthorization({
          transactionId,
          description: "Duplicate preauthorization hold cancelled",
        });
        holdTransactionId = null;
      } catch (error) {
        duplicateCancelFailed = true;
        await logError({
          type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
          transactionId: idempotencyKey,
          providerRef: transactionId,
          stationCode,
          phoneNumber,
          message: "Failed to cancel duplicate preauthorization hold",
          metadata: {
            idempotencyKey,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
      }

      await logError({
        type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: "Duplicate payment transaction detected — hold cancellation attempted",
        metadata: {
          idempotencyKey,
          cancelFailed: duplicateCancelFailed,
        },
      });

      await markTransactionFailed(
        idempotencyKey,
        "Provider returned a transaction already used by an existing rental",
      );
      throw new HttpError(409, "Duplicate payment transaction detected", {
        transactionId,
      });
    }

    await ensurePaymentTransactionState(idempotencyKey, "held");

    let unlock: unknown = null;
    let unlockAttempts = 0;
    let lastUnlockError: unknown = null;
    const currentBattery = battery;
    let lastKnownPresence: BatteryPresence = "unknown";
    let verifiedEjection = false;
    let unlockCommandAccepted = false;
    const preUnlockSnapshot = await getBatterySnapshot(
      imei,
      currentBattery.battery_id,
      currentBattery.slot_id,
    );

    if (preUnlockSnapshot.presence !== "present") {
      // Hold is already placed — must cancel it to release user's funds
      await logError({
        type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: "Battery not present in slot before unlock — hold will be cancelled",
        metadata: {
          imei,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
          preUnlockPresence: preUnlockSnapshot.presence,
        },
      });

      try {
        await cancelWaafiPreauthorization({
          transactionId,
          description: "Battery not in slot before unlock, hold cancelled",
        });
        holdTransactionId = null;
      } catch (cancelErr) {
        await logError({
          type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
          transactionId: idempotencyKey,
          providerRef: transactionId,
          stationCode,
          phoneNumber,
          message: "Failed to cancel hold after battery-not-in-slot — REQUIRES MANUAL INTERVENTION",
          metadata: {
            imei,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
            cancelError: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
          },
        });
      }

      await markTransactionFailed(
        idempotencyKey,
        "Battery not present in slot before unlock attempt",
      );

      throw new HttpError(
        409,
        "Selected battery is no longer in slot before unlock. Please retry.",
      );
    }

    const processStartTime = Date.now();
    const VERIFICATION_TIMEOUT_MS = 12000;

    let confidence: DeliveryConfidence = "LOW";
    let verification: VerificationResult | null = null;

    for (let attempt = 1; attempt <= MAX_UNLOCK_ATTEMPTS; attempt++) {
      unlockAttempts = attempt;
      unlockCommandAccepted = false;

      try {
        unlock = await releaseBattery({
          imei,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
        });
        unlockCommandAccepted = true;

        verification = await verifyDeliveryWithConfidence(
          imei,
          currentBattery.battery_id,
          currentBattery.slot_id,
          {
            stationCode,
            phoneNumber,
            transactionId: idempotencyKey
          }
        );

        confidence = verification.confidence;

        if (confidence === "HIGH") {
          verifiedEjection = true;
          lastUnlockError = null;
          break;
        }

        if (confidence === "MEDIUM") {
          // Rule: If MEDIUM, we stop retrying and ask user for confirmation
          lastUnlockError = new Error("Delivery confidence is MEDIUM - user confirmation required");
          break;
        }

        // Logic for LOW confidence: retry if time permits
        const elapsed = Date.now() - processStartTime;
        if (elapsed > VERIFICATION_TIMEOUT_MS) {
          await logError({
            type: "VERIFICATION_TIMEOUT",
            transactionId: idempotencyKey,
            stationCode,
            phoneNumber,
            message: "Max time exceeded during unlock/verification",
            metadata: { elapsed, attempt }
          });
          break;
        }

        lastUnlockError = new Error(`Verification confidence is ${confidence}`);
      } catch (unlockError) {
        lastUnlockError = unlockError;
        await logError({
          type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
          transactionId: idempotencyKey,
          providerRef: transactionId,
          stationCode,
          phoneNumber,
          message: `Unlock attempt ${attempt}/${MAX_UNLOCK_ATTEMPTS} failed`,
          metadata: {
            error: unlockError instanceof Error ? unlockError.message : String(unlockError)
          }
        });
      }

      if (attempt < MAX_UNLOCK_ATTEMPTS && confidence === "LOW") {
        await delay(UNLOCK_RETRY_DELAY_MS);
      }
    }

    // --- Capture Rules ---

    if (confidence === "MEDIUM") {
      // Step 4: Optional User Confirmation for MEDIUM
      // Transition to confirm_required state and persist metadata for later resolution
      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "held",
        to: "confirm_required",
        patch: {
          confirmRequiredAt: Date.now(),
          delivery: {
            imei,
            stationCode,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
            phoneAuthority,
            unlockAttempts,
            requestedPhoneNumber: phoneNumber,
            canonicalPhoneNumber,
          },
          waafiAudit: preauthAudit,
        },
      });

      return {
        status: "confirm_required",
        message: "Did the power bank come out?",
        transactionId: idempotencyKey
      };
    }

    if (confidence !== "HIGH") {
      const failureNote = (lastUnlockError instanceof Error ? lastUnlockError.message : String(lastUnlockError || "")) || `Verification failed with ${confidence} confidence`;

      await logError({
        type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: "Battery ejection could not be verified — payment NOT captured",
        metadata: {
          imei,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
          unlockAttempts,
          confidence,
          verification,
          failureNote,
          lastUnlockError: lastUnlockError instanceof Error
            ? lastUnlockError.message
            : String(lastUnlockError ?? "none"),
        },
      });

      if (confidence === "LOW") {
        try {
          await markProblemSlot(
            imei,
            currentBattery.slot_id,
            currentBattery.battery_id,
            failureNote,
          );
        } catch (recoveryError) {
          await logError({
            type: "PROBLEM_SLOT_MARK_FAILED",
            transactionId: idempotencyKey,
            providerRef: transactionId,
            stationCode,
            phoneNumber,
            message: "Failed to mark problem slot after ejection verification failure",
            metadata: {
              imei,
              batteryId: currentBattery.battery_id,
              slotId: currentBattery.slot_id,
              error: recoveryError instanceof Error
                ? recoveryError.message
                : String(recoveryError),
            },
          });
        }
      }

      await notifyPaidButNotEjected({
        phoneNumber,
        amount,
        imei,
        stationCode,
        batteryId: currentBattery.battery_id,
        slotId: currentBattery.slot_id,
        transactionId,
        issuerTransactionId,
        referenceId,
        unlockAttempts,
        reason: failureNote,
      });

      let cancelError: unknown = null;

      try {
        const cancelResponse = await cancelWaafiPreauthorization({
          transactionId,
          description: "Battery ejection not verified, hold cancelled",
        });
        holdTransactionId = null;

        if (!isWaafiApproved(cancelResponse)) {
          cancelError = new Error(
            cancelResponse.responseMsg || "Waafi cancel was not approved",
          );
        }
      } catch (error) {
        cancelError = error;
      }

      if (cancelError) {
        await logError({
          type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
          transactionId: idempotencyKey,
          providerRef: transactionId,
          stationCode,
          phoneNumber,
          message: "Ejection failed AND hold cancellation failed — REQUIRES MANUAL INTERVENTION",
          metadata: {
            imei,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
            unlockAttempts,
            cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError),
          },
        });

        await markTransactionFailed(
          idempotencyKey,
          `Ejection not verified and hold cancel not confirmed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
        );
        throw new HttpError(
          502,
          "Battery could not be released and payment hold cancellation could not be confirmed. Please contact support.",
          {
            transactionId,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
            unlockAttempts,
          },
        );
      }

      await markTransactionFailed(
        idempotencyKey,
        `Ejection not verified, payment hold cancelled: ${failureNote}`,
      );

      throw new HttpError(
        502,
        "Battery could not be released. Payment hold was cancelled.",
        {
          transactionId,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
          unlockAttempts,
        },
      );
    }

    return finalizeCapture(idempotencyKey);
  } catch (error) {
    if (holdCreated && holdTransactionId) {
      try {
        await cancelHold(holdTransactionId, "Payment failed before ejection, automatic early exit cleanup");
      } catch (err) {
        await logError({
          type: "SYSTEM_INCONSISTENCY",
          transactionId: holdTransactionId,
          message: "Failed to cancel Waafi hold on early exit",
          metadata: { error: String(err) },
        });
      }
    }

    await markTransactionFailed(
      idempotencyKey,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    if (reservedBatteryId) {
      await releaseReservation(imei, reservedBatteryId);
    }
    await releasePhonePaymentLock(phoneNumber);
  }
}

/**
 * Finalizes capture and rental creation for a verified delivery.
 * IDEMPOTENT: returns success if already captured.
 */
export async function finalizeCapture(idempotencyKey: string): Promise<any> {
  const tx = await getPaymentTransaction(idempotencyKey);

  if (!tx || (tx.status !== "held" && tx.status !== "confirm_required" && tx.status !== "captured" && tx.status !== "verified")) {
    throw new HttpError(400, `Transaction in invalid state for capture: ${tx?.status}`);
  }

  // Idempotency: If already captured and rental created, return success
  if (tx.status === "captured" && tx.rentalCreated) {
    return {
      status: "captured",
      success: true,
      battery_id: tx.delivery?.batteryId,
      slot_id: tx.delivery?.slotId
    };
  }

  const {
    providerRef: transactionId,
    providerIssuerRef: issuerTransactionId,
    providerReferenceId: referenceId,
    waafiAudit: preauthAudit,
    delivery,
    phone: phoneNumber,
    amount,
    station: stationCode,
  } = tx;

  if (!delivery) {
    throw new HttpError(500, "Missing delivery metadata for capture");
  }

  const {
    imei,
    batteryId,
    slotId,
    phoneAuthority,
    unlockAttempts,
    canonicalPhoneNumber,
  } = delivery;

  // 1. Move to 'verified' state if not already past it
  if (tx.status !== "verified" && tx.status !== "captured") {
    await transitionPaymentTransactionState({
      id: idempotencyKey,
      from: tx.status,
      to: "verified",
      patch: { verifiedAt: Date.now() },
    });
  }

  // 2. Commit Waafi (Only if not already captured)
  if (tx.status !== "captured") {
    let commitResponse;
    try {
      commitResponse = await commitWaafiPreauthorization({
        transactionId: transactionId!,
        description: "Powerbank rental committed after delivery verification",
      });
    } catch (error) {
      await logError({
        type: CRITICAL_ERROR_TYPES.SYSTEM_INCONSISTENCY,
        transactionId: idempotencyKey,
        message: "Waafi capture retry or failure",
        metadata: { error: String(error) }
      });
      throw error;
    }

    if (!isWaafiApproved(commitResponse)) {
      throw new Error("Waafi capture not approved");
    }

    // Move to 'captured' state
    await transitionPaymentTransactionState({
      id: idempotencyKey,
      from: "verified",
      to: "captured",
      patch: { capturedAt: Date.now(), rentalCreated: false },
    });
  }

  // 3. Create Rental Log (Only if not already created)
  if (!tx.rentalCreated) {
    const rentalRef = await createRentalLog({
      imei,
      stationCode,
      batteryId,
      slotId,
      phoneNumber: canonicalPhoneNumber,
      requestedPhoneNumber: phoneNumber,
      amount,
      transactionId: transactionId!,
      issuerTransactionId: issuerTransactionId || null,
      referenceId: referenceId || "manual",
      phoneAuthority,
      waafiAudit: preauthAudit || {},
    });

    await patchPaymentTransaction({
      id: idempotencyKey,
      patch: { rentalCreated: true, rentalId: rentalRef.id },
    });

    await releaseReservation(imei, batteryId);
    await updateRentalUnlockStatus(rentalRef.id, "unlocked");
  }

  return { status: "captured", success: true, battery_id: batteryId, slot_id: slotId };
}

/**
 * Cancels a hold safely.
 * IDEMPOTENT: returns success if already failed.
 */
export async function cancelHold(idempotencyKey: string, reason: string): Promise<any> {
  const tx = await getPaymentTransaction(idempotencyKey);

  if (tx?.status === "failed") {
    return { status: "failed", success: true };
  }

  if (!tx || (tx.status !== "held" && tx.status !== "confirm_required")) {
    throw new HttpError(400, "Transaction in invalid state for cancellation");
  }

  if (tx.providerRef) {
    await cancelWaafiPreauthorization({
      transactionId: tx.providerRef,
      description: reason,
    });
  }

  await markTransactionFailed(idempotencyKey, reason);
  return { status: "failed", success: true };
}

/**
 * Handles user confirmation (YES/NO) from the frontend for MEDIUM confidence cases.
 */
export async function handleUserConfirmation(
  idempotencyKey: string,
  confirmed: boolean,
): Promise<any> {
  const tx = await getPaymentTransaction(idempotencyKey);

  // 1. Idempotency Check
  if (tx?.status === "captured" || tx?.status === "failed") {
    return { status: tx.status };
  }

  // 2. Timeout Check (60 seconds)
  if (tx?.status === "confirm_required" && tx.updatedAt) {
    const elapsedSeconds = (Date.now() - tx.updatedAt) / 1000;
    if (elapsedSeconds > 60) {
      await logError({
        type: CRITICAL_ERROR_TYPES.VERIFICATION_TIMEOUT,
        transactionId: idempotencyKey,
        message: "Confirmation timeout - auto-cancelling hold",
      });
      return cancelHold(idempotencyKey, "Confirmation timed out (60s)");
    }
  }

  // 3. State Check
  if (!tx || tx.status !== "confirm_required") {
    throw new HttpError(400, `Confirmation not allowed for status: ${tx?.status || "unknown"}`);
  }

  await logError({
    type: "USER_CONFIRMATION",
    transactionId: idempotencyKey,
    stationCode: tx.station,
    message: `User confirmed delivery: ${confirmed}`,
    metadata: { confirmed }
  });

  if (confirmed) {
    return finalizeCapture(idempotencyKey);
  } else {
    return cancelHold(idempotencyKey, "User reported battery did not come out");
  }
}

/**
 * Shared hardware ejection and verification logic.
 */
async function performEjectionAndVerification(input: {
  idempotencyKey: string;
  transactionId: string;
  stationCode: string;
  phoneNumber: string;
  imei: string;
  battery: { battery_id: string; slot_id: string };
  preauthAudit: Record<string, unknown>;
  phoneAuthority: string;
  canonicalPhoneNumber: string;
}) {
  const {
    idempotencyKey,
    transactionId,
    stationCode,
    phoneNumber,
    imei,
    battery,
    preauthAudit,
    phoneAuthority,
    canonicalPhoneNumber
  } = input;

  await ensurePaymentTransactionState(idempotencyKey, "held");

  let unlockAttempts = 0;
  let lastUnlockError: unknown = null;
  const currentBattery = battery;
  let confidence: DeliveryConfidence = "LOW";
  let verification: VerificationResult | null = null;

  const preUnlockSnapshot = await getBatterySnapshot(imei, currentBattery.battery_id, currentBattery.slot_id);

  if (preUnlockSnapshot.presence !== "present") {
    await logError({
      type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
      transactionId: idempotencyKey,
      providerRef: transactionId,
      stationCode,
      message: "Battery not present in slot before unlock — hold will be cancelled",
    });

    try {
      await cancelWaafiPreauthorization({ transactionId, description: "Battery not in slot before unlock" });
    } catch (cancelErr) {
      console.error("Critical: Failed to cancel hold in failed verify", cancelErr);
    }

    await markTransactionFailed(idempotencyKey, "Battery missing before unlock");
    throw new HttpError(409, "Battery is no longer in slot. Please retry.");
  }

  const processStartTime = Date.now();
  for (let attempt = 1; attempt <= MAX_UNLOCK_ATTEMPTS; attempt++) {
    unlockAttempts = attempt;
    try {
      await releaseBattery({ imei, batteryId: currentBattery.battery_id, slotId: currentBattery.slot_id });
      verification = await verifyDeliveryWithConfidence(imei, currentBattery.battery_id, currentBattery.slot_id, {
        stationCode,
        phoneNumber,
        transactionId: idempotencyKey
      });

      confidence = verification.confidence;
      if (confidence === "HIGH" || confidence === "MEDIUM") break;

      await logError({
        type: "RETRYING_UNLOCK",
        transactionId: idempotencyKey,
        message: `Unlock attempt ${attempt} failed (Confidence: ${confidence}).`,
        metadata: { verification }
      });
    } catch (err) {
      lastUnlockError = err;
    }

    if (Date.now() - processStartTime > 12000) break;
  }

  // Final Decision
  if (confidence === "MEDIUM") {
    await transitionPaymentTransactionState({
      id: idempotencyKey,
      from: "held",
      to: "confirm_required",
      patch: {
        confirmRequiredAt: Date.now(),
        delivery: {
          imei,
          stationCode,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
          phoneAuthority,
          unlockAttempts,
          requestedPhoneNumber: phoneNumber,
          canonicalPhoneNumber,
        },
        waafiAudit: preauthAudit,
      },
    });

    return { status: "confirm_required", message: "Did the power bank come out?", transactionId: idempotencyKey };
  }

  if (confidence !== "HIGH") {
    const failureNote = (lastUnlockError instanceof Error ? lastUnlockError.message : String(lastUnlockError || "")) || `Low confidence: ${confidence}`;
    await cancelHold(transactionId, "Battery ejection not verified");
    await markTransactionFailed(idempotencyKey, `Ejection not verified: ${failureNote}`);

    throw new HttpError(502, "Battery could not be released. Payment hold was cancelled.", { transactionId });
  }

  return finalizeCapture(idempotencyKey);
}

/**
 * Resumes hardware ejection for a transaction that was in 'pending_payment'
 * once it is verified as PAID.
 */
export async function resumePendingPayment(transaction: PaymentTransactionRecord) {
  const { id: idempotencyKey, phone: phoneNumber, station: stationCode, delivery, waafiAudit } = transaction;

  if (!delivery || !waafiAudit) {
    throw new Error("Cannot resume pending payment: missing delivery/audit metadata");
  }

  const { imei, batteryId, slotId } = delivery;

  // Transition from pending_payment -> held to start hardware flow
  await transitionPaymentTransactionState({
    id: idempotencyKey,
    from: "pending_payment",
    to: "held",
    patch: {
      verifiedPaidAt: Date.now(),
    }
  });

  return performEjectionAndVerification({
    idempotencyKey,
    transactionId: transaction.providerRef!,
    stationCode,
    phoneNumber,
    imei,
    battery: { battery_id: batteryId, slot_id: slotId },
    preauthAudit: waafiAudit as Record<string, unknown>,
    phoneAuthority: delivery.phoneAuthority || "async_confirmed",
    canonicalPhoneNumber: phoneNumber,
  });
}
