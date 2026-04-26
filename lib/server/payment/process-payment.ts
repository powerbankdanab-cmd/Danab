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
  createRental,
  getRentalByTransactionId,
  hasActiveRentalForPhone,
  isDuplicateTransaction,
  updateRentalUnlockStatus,
} from "@/lib/server/payment/rentals";
import { getActiveStationCode, getStationImei } from "@/lib/server/payment/station";
import { getStationConfigByCode } from "@/lib/server/station-config";

import { PaymentInput, PaymentPayload } from "@/lib/server/payment/types";
import { CRITICAL_ERROR_TYPES, logError } from "@/lib/server/alerts/log-error";
import {
  createOrGetPaymentTransaction,
  ensurePaymentTransactionState,
  getPaymentTransaction,
  patchPaymentTransaction,
  transitionPaymentTransactionState,
  markUnlockStarted,
  PaymentTransactionRecord,
  logTransactionEvent,
} from "@/lib/server/payment/transactions";
import { reconcileTransactionById } from "@/lib/server/payment/reconciliation";
import {
  cancelWaafiPreauthorization,
  commitWaafiPreauthorization,
  extractWaafiAudit,
  extractWaafiIds,
  isWaafiApproved,
  isWaafiCaptured,
  mergeWaafiAuditRecords,
  queryWaafiTransactionStatus,
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
const CONFIRMATION_TIMEOUT_MS = 120_000;

// Phase 4 hardening: capture retry backoff
const CAPTURE_MAX_RETRIES = 5;
const CAPTURE_MIN_RETRY_INTERVAL_MS = 10_000; // 10s minimum between capture attempts

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TimestampLike =
  | number
  | Date
  | {
    toMillis?: () => number;
    seconds?: number;
  }
  | null
  | undefined;

function toMillis(value: TimestampLike): number | null {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object") {
    if (typeof value.toMillis === "function") {
      return value.toMillis();
    }
    if (typeof value.seconds === "number") {
      return value.seconds * 1000;
    }
  }
  return null;
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

  // Phase 4: Do NOT mark as failed if provider capture already completed
  // This prevents money/state divergence
  if (tx.status === "capture_in_progress" && tx.captureCompleted) {
    await logError({
      type: CRITICAL_ERROR_TYPES.CAPTURE_FAIL_BLOCKED,
      transactionId,
      message: "Attempted to mark capture_in_progress as failed but provider capture already completed — blocking to prevent money divergence",
      metadata: {
        reason,
        providerCaptureRef: tx.providerCaptureRef,
      },
    });
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

    if (txRecord.record.status === "pending_payment") {
      return {
        status: "pending",
        message: "waiting_for_user_payment",
        transactionId: txRecord.record.id,
      };
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
      const pendingIds = extractWaafiIds(preauthResponse);
      const pendingAudit = extractWaafiAudit(preauthResponse);
      const waafiConfirmedPhoneNumber =
        typeof pendingAudit.waafiConfirmedPhoneNumber === "string" &&
          pendingAudit.waafiConfirmedPhoneNumber.trim().length > 0
          ? pendingAudit.waafiConfirmedPhoneNumber.trim()
          : null;
      const canonicalPhoneNumber = phoneNumber;
      const phoneAuthority = waafiConfirmedPhoneNumber
        ? waafiConfirmedPhoneNumber === phoneNumber
          ? "waafi_confirmed_full_match"
          : "requested_phone_waafi_mismatch"
        : "requested_phone_only";

      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "initiated",
        to: "pending_payment",
        patch: {
          providerRef: pendingIds.transactionId || null,
          providerIssuerRef: pendingIds.issuerTransactionId || null,
          providerReferenceId: pendingIds.referenceId || preauthReferenceId,
          pendingReason: "WAAFI_NOT_IMMEDIATE_SUCCESS",
          waafiAudit: pendingAudit,
          updatedAt: Date.now(),
          delivery: {
            imei,
            stationCode,
            batteryId: reservedBatteryId,
            slotId: battery.slot_id,
            phoneAuthority,
            unlockAttempts: 0,
            requestedPhoneNumber: phoneNumber,
            canonicalPhoneNumber,
          },
        },
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

    if (!transactionId || !reservedBatteryId || !battery?.slot_id) {
      throw new HttpError(500, "INVALID_HELD_STATE");
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
          waafiAudit: preauthAudit,
          delivery: {
            imei,
            stationCode,
            batteryId: reservedBatteryId,
            slotId: battery.slot_id,
            phoneAuthority,
            unlockAttempts: 0,
            requestedPhoneNumber: phoneNumber,
            canonicalPhoneNumber,
          },
        },
      });

      await logTransactionEvent(idempotencyKey, "HELD", {
        providerRef: transactionId,
        station: stationCode,
        batteryId: reservedBatteryId,
        slotId: battery.slot_id,
        amount,
      }, "IMPORTANT");
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
    const currentBattery = battery;
    await patchPaymentTransaction({
      id: idempotencyKey,
      patch: {
        unlockStarted: true,
        processingStartedAt: Date.now(),
      },
    });
    await logTransactionEvent(idempotencyKey, "UNLOCK_PROCESS_STARTED", {
      station: stationCode,
      batteryId: currentBattery.battery_id,
      slotId: currentBattery.slot_id,
    }, "IMPORTANT");

    let unlock: unknown = null;
    let unlockAttempts = 0;
    let lastUnlockError: unknown = null;
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
    let lastUnlockStartedAt: number | null = null;

    for (let attempt = 1; attempt <= MAX_UNLOCK_ATTEMPTS; attempt++) {
      unlockAttempts = attempt;
      unlockCommandAccepted = false;

      try {
        lastUnlockStartedAt = Date.now();
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
          },
          lastUnlockStartedAt,
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
            unlockStartedAt: lastUnlockStartedAt ?? Date.now(),
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

      await logError({
        type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: `Paid but not ejected: ${failureNote}`,
        metadata: {
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
          imei,
          amount,
          unlockAttempts,
          issuerTransactionId,
          referenceId,
        },
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
 * Helper: Create rental record after capture is confirmed.
 * Shared by finalizeCapture's normal path and provider pre-check early-return.
 */
async function finalizeCaptureRentalStep(
  idempotencyKey: string,
  tx: { rentalCreated?: boolean },
  imei: string,
  stationCode: string,
  batteryId: string,
  slotId: string,
  canonicalPhoneNumber: string,
  phoneNumber: string,
  amount: number,
  transactionId: string,
  issuerTransactionId: string | null | undefined,
  referenceId: string | null | undefined,
  phoneAuthority: string,
  preauthAudit: Record<string, unknown> | undefined,
): Promise<any> {
  if (!tx.rentalCreated) {
    try {
      const rentalId = await createRental({
        transactionId: idempotencyKey,
        phone: canonicalPhoneNumber,
        stationId: stationCode,
        slotId,
        batteryId,
        imei,
        phoneAuthority,
        requestedPhoneNumber: phoneNumber,
        amount,
        issuerTransactionId,
        referenceId,
      });

      await patchPaymentTransaction({
        id: idempotencyKey,
        patch: { rentalCreated: true, rentalId },
      });

      await releaseReservation(imei, batteryId);
      await updateRentalUnlockStatus(rentalId, "unlocked");

      await logError({
        type: "RENTAL_CREATED",
        transactionId: idempotencyKey,
        message: "Rental record created successfully after capture",
        metadata: { rentalId, batteryId, slotId },
      });
    } catch (rentalError) {
      await logError({
        type: CRITICAL_ERROR_TYPES.RENTAL_CREATION_FAILED,
        transactionId: idempotencyKey,
        message: "CRITICAL: Payment captured but rental creation failed — will be recovered by reconciliation",
        metadata: {
          error: rentalError instanceof Error ? rentalError.message : String(rentalError),
          batteryId,
          slotId,
          stationCode,
        },
      });

      return {
        status: "captured",
        success: true,
        rentalPending: true,
        battery_id: batteryId,
        slot_id: slotId,
      };
    }
  }

  return { status: "captured", success: true, battery_id: batteryId, slot_id: slotId };
}

/**
 * Finalizes capture and rental creation for a verified delivery.
 *
 * Phase 4: IDEMPOTENT + CRASH-SAFE capture flow.
 *
 * State machine:
 *   held/confirm_required/resolving → verified → capture_in_progress → captured
 *
 * Safety guarantees:
 *   - captureAttempted is written BEFORE the provider call (crash breadcrumb)
 *   - captureCompleted + providerCaptureRef stored BEFORE state → captured
 *   - If already captured, skips provider call entirely (no double capture)
 *   - Rental creation failure after capture is caught and logged (recoverable)
 *   - Every code path returns or throws — no silent fallthrough
 */
export async function finalizeCapture(idempotencyKey: string): Promise<any> {
  const tx = await getPaymentTransaction(idempotencyKey);

  const CAPTURABLE_STATES = new Set([
    "held", "confirm_required", "verified",
    "capture_in_progress", "captured", "resolving",
  ]);

  if (!tx || !CAPTURABLE_STATES.has(tx.status)) {
    throw new HttpError(400, `Transaction in invalid state for capture: ${tx?.status}`);
  }

  // ── Idempotency: already fully complete ──────────────────────────
  if (tx.status === "captured" && tx.rentalCreated) {
    return {
      status: "captured",
      success: true,
      rentalId: tx.rentalId,
      battery_id: tx.delivery?.batteryId,
      slot_id: tx.delivery?.slotId,
    };
  }

  // ── Idempotency: capture already confirmed, just finish rental ───
  if (tx.captureCompleted && tx.status === "captured") {
    // Rental step will handle the rest
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

  // ── Step 1: Transition to verified (if not already past it) ──────
  if (tx.status !== "verified" && tx.status !== "capture_in_progress" && tx.status !== "captured") {
    await transitionPaymentTransactionState({
      id: idempotencyKey,
      from: tx.status,
      to: "verified",
      patch: { verifiedAt: Date.now() },
    });
  }

  // ── Step 2: Provider capture (only if not already completed) ─────
  if (tx.status !== "captured") {
    // Phase 4 idempotency guard: skip provider call if already completed locally
    if (tx.captureCompleted) {
      await logError({
        type: "CAPTURE_SKIPPED_ALREADY_CAPTURED",
        transactionId: idempotencyKey,
        message: "Capture already completed by provider — skipping commit call",
        metadata: {
          providerCaptureRef: tx.providerCaptureRef,
          currentStatus: tx.status,
        },
      });
    } else {
      // ── Retry backoff guard ──────────────────────────────────────
      const retryCount = tx.captureRetryCount || 0;
      if (retryCount >= CAPTURE_MAX_RETRIES) {
        await logError({
          type: CRITICAL_ERROR_TYPES.CAPTURE_RETRY_EXHAUSTED,
          transactionId: idempotencyKey,
          message: `Capture retry limit reached (${retryCount}/${CAPTURE_MAX_RETRIES}) — deferring to reconciliation`,
          metadata: { retryCount, lastAttemptAt: tx.captureAttemptedAt },
        });
        throw new Error(`Capture retry limit reached (${retryCount}/${CAPTURE_MAX_RETRIES})`);
      }

      if (
        tx.captureAttemptedAt &&
        (Date.now() - tx.captureAttemptedAt) < CAPTURE_MIN_RETRY_INTERVAL_MS
      ) {
        await logError({
          type: "CAPTURE_RETRY_SCHEDULED",
          transactionId: idempotencyKey,
          message: "Capture retry too soon — deferring to avoid provider spam",
          metadata: {
            msSinceLastAttempt: Date.now() - tx.captureAttemptedAt,
            minInterval: CAPTURE_MIN_RETRY_INTERVAL_MS,
          },
        });
        throw new Error("Capture retry cooldown not elapsed");
      }

      // ── Provider-level idempotency pre-check ─────────────────────
      // Before calling commit, check if the provider already captured.
      // This prevents double-capture even if local captureCompleted was
      // never written (crash between provider response and DB write).
      if (transactionId) {
        try {
          const providerStatus = await queryWaafiTransactionStatus({
            transactionId,
            referenceId: referenceId || null,
          });

          if (isWaafiCaptured(providerStatus)) {
            // Provider already captured — do NOT call commit again
            const captureRef = providerStatus.params?.transactionId || transactionId;
            await patchPaymentTransaction({
              id: idempotencyKey,
              patch: {
                captureCompleted: true,
                providerCaptureRef: captureRef,
                captureRetryCount: retryCount,
              },
            });

            await logError({
              type: "CAPTURE_SKIPPED_ALREADY_CAPTURED",
              transactionId: idempotencyKey,
              message: "Provider pre-check confirms capture already completed — skipping commit call",
              metadata: { providerCaptureRef: captureRef, detectedVia: "provider_pre_check" },
            });

            // Skip directly to state transition below
            const fromState = tx.status === "capture_in_progress" ? "capture_in_progress" : "verified";
            await transitionPaymentTransactionState({
              id: idempotencyKey,
              from: fromState as any,
              to: "captured",
              patch: { capturedAt: Date.now(), rentalCreated: false },
            });

            // Jump to rental creation (step 3)
            // Will be handled below since we exit this if-block
            return await finalizeCaptureRentalStep(
              idempotencyKey, tx, imei, stationCode, batteryId, slotId,
              canonicalPhoneNumber, phoneNumber, amount, transactionId!,
              issuerTransactionId, referenceId, phoneAuthority, preauthAudit,
            );
          }
        } catch (preCheckError) {
          // Provider pre-check failed — log but continue with commit attempt.
          // This is non-fatal: we'll try the commit and let it fail/succeed normally.
          await logError({
            type: "CAPTURE_PRECHECK_FAILED",
            transactionId: idempotencyKey,
            message: "Provider status pre-check failed — proceeding with commit attempt",
            metadata: {
              error: preCheckError instanceof Error ? preCheckError.message : String(preCheckError),
            },
          });
        }
      }

      // ── Transition to capture_in_progress ─────────────────────────
      if (tx.status !== "capture_in_progress") {
        await logTransactionEvent(idempotencyKey, "CAPTURE_INITIATED", {
          providerRef: transactionId,
          attempt: retryCount + 1,
        }, "IMPORTANT");

        await transitionPaymentTransactionState({
          id: idempotencyKey,
          from: "verified",
          to: "capture_in_progress",
          patch: {
            captureAttempted: true,
            captureAttemptedAt: Date.now(),
            captureRetryCount: retryCount + 1,
          },
        });

        await logError({
          type: "CAPTURE_STARTED",
          transactionId: idempotencyKey,
          message: "Capture initiated — calling provider",
          metadata: { providerRef: transactionId, attempt: retryCount + 1 },
        });
      } else {
        // Already in capture_in_progress (retry path) — update attempt tracking
        await patchPaymentTransaction({
          id: idempotencyKey,
          patch: {
            captureAttemptedAt: Date.now(),
            captureRetryCount: retryCount + 1,
          },
        });
      }

      // ── Call provider ─────────────────────────────────────────────
      let commitResponse;
      try {
        commitResponse = await commitWaafiPreauthorization({
          transactionId: transactionId!,
          description: "Powerbank rental committed after delivery verification",
        });
      } catch (error) {
        await logError({
          type: "CAPTURE_FAILED",
          transactionId: idempotencyKey,
          message: "Waafi capture API call failed",
          metadata: {
            error: error instanceof Error ? error.message : String(error),
            providerRef: transactionId,
            attempt: retryCount + 1,
          },
        });
        // Leave in capture_in_progress for reconciliation to pick up
        throw error;
      }

      if (!isWaafiApproved(commitResponse)) {
        await logError({
          type: "CAPTURE_FAILED",
          transactionId: idempotencyKey,
          message: "Waafi capture not approved by provider",
          metadata: {
            providerRef: transactionId,
            responseCode: commitResponse.responseCode,
            responseMsg: commitResponse.responseMsg,
          },
        });
        throw new Error("Waafi capture not approved");
      }

      // Store provider capture reference BEFORE marking captured
      const captureRef = commitResponse.params?.transactionId || transactionId;
      await patchPaymentTransaction({
        id: idempotencyKey,
        patch: {
          captureCompleted: true,
          providerCaptureRef: captureRef,
        },
      });

      await logTransactionEvent(idempotencyKey, "PROVIDER_CAPTURE_SUCCESS", {
        providerCaptureRef: captureRef,
        attempt: retryCount + 1,
      }, "IMPORTANT");

      await logError({
        type: "CAPTURE_SUCCESS",
        transactionId: idempotencyKey,
        message: "Provider capture confirmed — transitioning to captured",
        metadata: { providerCaptureRef: captureRef, attempt: retryCount + 1 },
      });
    }

    // Transition: capture_in_progress → captured
    // (safe even after crash: captureCompleted is already true)
    const fromState = tx.captureCompleted ? tx.status : "capture_in_progress";
    await transitionPaymentTransactionState({
      id: idempotencyKey,
      from: fromState as any,
      to: "captured",
      patch: { capturedAt: Date.now(), rentalCreated: false },
    });
  }

  // ── Step 3: Create rental (via shared helper) ─────────────────────
  return await finalizeCaptureRentalStep(
    idempotencyKey, tx, imei, stationCode, batteryId, slotId,
    canonicalPhoneNumber, phoneNumber, amount, transactionId!,
    issuerTransactionId, referenceId, phoneAuthority, preauthAudit,
  );
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

  // Split-brain guard: do NOT cancel if unlock already started
  if (tx.unlockStarted) {
    await logError({
      type: "CANCEL_ABORTED_UNLOCK_STARTED",
      transactionId: idempotencyKey,
      message: "Cancellation aborted because unlock has already started",
      metadata: { status: tx.status, unlockStarted: tx.unlockStarted },
    });
    throw new HttpError(400, "Cannot cancel a transaction that has already started unlock");
  }

  if (tx.providerRef) {
    await logTransactionEvent(idempotencyKey, "CANCELLING_PROVIDER_HOLD", {
      providerRef: tx.providerRef,
      reason,
    }, "IMPORTANT");

    const cancelResponse = await cancelWaafiPreauthorization({
      transactionId: tx.providerRef,
      description: reason,
    });

    if (cancelResponse?.responseCode !== 200 && cancelResponse?.responseCode !== 5206) {
       // 5206 typically means already cancelled or not found
       await logError({
         type: CRITICAL_ERROR_TYPES.PROVIDER_CANCEL_FAILED,
         transactionId: idempotencyKey,
         message: "CRITICAL: Provider cancellation failed to confirm. Money may still be held!",
         metadata: {
           responseCode: cancelResponse?.responseCode,
           responseMsg: cancelResponse?.responseMsg,
           providerRef: tx.providerRef,
         },
       });
       // We still mark it failed locally but the critical error will alert ops
    } else {
       await logTransactionEvent(idempotencyKey, "PROVIDER_CANCEL_CONFIRMED", {
         providerRef: tx.providerRef,
       }, "IMPORTANT");
    }
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

  // 2. Timeout Check (120 seconds)
  if (tx?.status === "confirm_required") {
    const confirmRequiredAtMs = toMillis(tx.confirmRequiredAt ?? tx.updatedAt) ?? Date.now();
    const elapsedMs = Date.now() - confirmRequiredAtMs;
    if (elapsedMs > CONFIRMATION_TIMEOUT_MS) {
      await logError({
        type: CRITICAL_ERROR_TYPES.VERIFICATION_TIMEOUT,
        transactionId: idempotencyKey,
        message: "Confirmation timeout - auto-cancelling hold",
        metadata: { elapsedMs },
      });
      return cancelHold(idempotencyKey, "Confirmation timed out (120s)");
    }
  }

  // 3. State Check
  if (!tx || tx.status !== "confirm_required") {
    throw new HttpError(400, `Confirmation not allowed for status: ${tx?.status || "unknown"}`);
  }

  await logTransactionEvent(idempotencyKey, "USER_CONFIRMATION_RECEIVED", {
    confirmed,
  }, "IMPORTANT");

  await logError({
    type: "USER_CONFIRMATION",
    transactionId: idempotencyKey,
    stationCode: tx.station,
    message: `User confirmed delivery: ${confirmed}`,
    metadata: { confirmed }
  });

  // 4. Set state to resolving (transactional)
  await transitionPaymentTransactionState({
    id: idempotencyKey,
    from: "confirm_required",
    to: "resolving",
  });

  try {
    if (confirmed) {
      return await finalizeCapture(idempotencyKey);
    } else {
      return await cancelHold(idempotencyKey, "User reported battery did not come out");
    }
  } catch (error) {
    // If provider call fails, transition back to confirm_required to allow retry
    await transitionPaymentTransactionState({
      id: idempotencyKey,
      from: "resolving",
      to: "confirm_required",
    }).catch(() => undefined); // Don't throw on cleanup
    throw error;
  }
}

/**
 * Shared hardware ejection and verification logic.
 */
export async function performEjectionAndVerification(input: {
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

  // ── Atomic exactly-once guard ──────────────────────────────
  const started = await markUnlockStarted(idempotencyKey);
  if (!started) {
    console.info("unlock_already_started_skipping", { idempotencyKey });
    return;
  }
  await logTransactionEvent(idempotencyKey, "UNLOCK_PROCESS_STARTED", {
    station: stationCode,
    batteryId: currentBattery.battery_id,
    slotId: currentBattery.slot_id,
  }, "IMPORTANT");

  let unlockAttempts = 0;
  let lastUnlockError: unknown = null;
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
  let lastUnlockStartedAt: number | null = null;
  for (let attempt = 1; attempt <= MAX_UNLOCK_ATTEMPTS; attempt++) {
    unlockAttempts = attempt;
    try {
      lastUnlockStartedAt = Date.now();
      await releaseBattery({ imei, batteryId: currentBattery.battery_id, slotId: currentBattery.slot_id });
      await logTransactionEvent(idempotencyKey, "UNLOCK_SUCCESS", {
        attempt,
        batteryId: currentBattery.battery_id,
        slotId: currentBattery.slot_id,
      }, "IMPORTANT");

      verification = await verifyDeliveryWithConfidence(imei, currentBattery.battery_id, currentBattery.slot_id, {
        stationCode,
        phoneNumber,
        transactionId: idempotencyKey
      }, lastUnlockStartedAt);

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
      await logTransactionEvent(idempotencyKey, "UNLOCK_FAILED", {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      }, "CRITICAL");
    }
  }

  // Final Decision
  if (confidence === "MEDIUM") {
    await logTransactionEvent(idempotencyKey, "VERIFICATION_MEDIUM", {
      unlockAttempts,
      batteryId: currentBattery.battery_id,
      slotId: currentBattery.slot_id,
    }, "IMPORTANT");

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
    if (confidence === "LOW") {
      await logTransactionEvent(idempotencyKey, "VERIFICATION_LOW", {
        unlockAttempts,
        batteryId: currentBattery.battery_id,
        slotId: currentBattery.slot_id,
        failureNote,
      }, "CRITICAL");
    }
    await cancelHold(transactionId, "Battery ejection not verified");
    await markTransactionFailed(idempotencyKey, `Ejection not verified: ${failureNote}`);

    throw new HttpError(502, "Battery could not be released. Payment hold was cancelled.", { transactionId });
  }

  await logTransactionEvent(idempotencyKey, "VERIFICATION_HIGH", {
    unlockAttempts,
    batteryId: currentBattery.battery_id,
    slotId: currentBattery.slot_id,
    confidence,
  }, "IMPORTANT");

  return finalizeCapture(idempotencyKey);
}

/**
 * Resumes hardware ejection for a transaction that was in 'pending_payment'
 * once it is verified as PAID.
 */
export async function resumePendingPayment(transaction: PaymentTransactionRecord) {
  const { id: idempotencyKey, phone: phoneNumber, station: stationCode, delivery, waafiAudit, providerRef } = transaction;

  if (!providerRef || !delivery || !waafiAudit) {
    throw new Error("INVALID_HELD_STATE");
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
