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

const MAX_UNLOCK_ATTEMPTS = 5;
const UNLOCK_RETRY_DELAY_MS = 2_000;
// Increased poll rounds for more confident detection.
// Each poll is a full HeyCharge station query.
const UNLOCK_VERIFY_POLL_MS = [250, 350, 400, 500] as const;
const REQUIRED_CONSECUTIVE_MISSING = 2;

type BatteryPresence = "present" | "missing" | "unknown";
type BatterySnapshot = {
  presence: BatteryPresence;
  lockStatus: string | null;
  slotStatus: string | null;
  batteryStatus: string | null;
  observedAt: number;
};

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

/**
 * Verify battery ejection after a successful unlock command.
 *
 * STRICT RULES:
 * 1. Requires REQUIRED_CONSECUTIVE_MISSING (2) consecutive "missing" reads
 *    to confirm ejection. A single "missing" read is NOT sufficient.
 * 2. Any "present" read between "missing" reads resets the counter.
 * 3. An "unknown" read does NOT count as "missing" — only definitive
 *    "missing" reads (battery not found in station query) count.
 * 4. If we finish the main polling without 2 consecutive missing reads,
 *    we do additional confirmation reads ONLY if we saw at least one
 *    missing. Both additional reads must return "missing".
 */
async function verifyEjectionAfterUnlock(
  imei: string,
  batteryId: string,
  slotId: string,
  preUnlock: BatterySnapshot,
): Promise<BatteryPresence> {
  let consecutiveMissing = 0;

  for (const waitMs of UNLOCK_VERIFY_POLL_MS) {
    await delay(waitMs);
    const snapshot = await getBatterySnapshot(imei, batteryId, slotId);

    if (snapshot.presence === "missing") {
      consecutiveMissing += 1;
      if (consecutiveMissing >= REQUIRED_CONSECUTIVE_MISSING) {
        return "missing";
      }
      continue;
    }

    if (snapshot.presence === "present") {
      // Battery is confirmed still in slot. Reset consecutive counter.
      consecutiveMissing = 0;

      // If pre-unlock was locked (lock_status "1") and still locked,
      // and we haven't confirmed any missing reads, the unlock may
      // not have taken effect yet — allow the loop to continue.
      if (
        preUnlock.presence === "present" &&
        preUnlock.lockStatus === "1" &&
        snapshot.lockStatus === "1"
      ) {
        continue;
      }

      return "present";
    }

    // "unknown" — API error; treat as inconclusive (do NOT count as missing)
    consecutiveMissing = 0;
  }

  // If we saw exactly 1 missing at the end of the loop, do 2 additional
  // confirmation reads. BOTH must return "missing" to confirm.
  if (consecutiveMissing === 1) {
    for (let confirm = 0; confirm < REQUIRED_CONSECUTIVE_MISSING; confirm++) {
      await delay(500);
      const snapshot = await getBatterySnapshot(imei, batteryId, slotId);
      if (snapshot.presence !== "missing") {
        // Confirmation failed — battery may still be present or state is indeterminate
        return snapshot.presence === "present" ? "present" : "unknown";
      }
    }
    // Both confirmation reads returned "missing" — now confident
    return "missing";
  }

  return "unknown";
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
    const preauthResponse = await requestWaafiPreauthorization({
      phoneNumber,
      amount,
      referenceId: preauthReferenceId,
    });

    if (!isWaafiApproved(preauthResponse)) {
      throw new HttpError(400, "Payment hold not approved", {
        waafiResponse: preauthResponse,
        waafiMsg: preauthResponse.responseMsg || "",
      });
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
        lastKnownPresence = await verifyEjectionAfterUnlock(
          imei,
          currentBattery.battery_id,
          currentBattery.slot_id,
          preUnlockSnapshot,
        );

        if (lastKnownPresence === "missing") {
          // Unlock command succeeded AND battery confirmed missing — verified ejection
          verifiedEjection = true;
          lastUnlockError = null;
          break;
        }

        lastUnlockError = new Error(
          lastKnownPresence === "present"
            ? "Battery unlock command succeeded, but battery is still present in slot"
            : "Battery unlock command succeeded, but eject could not be verified",
        );

        await logError({
        type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
        transactionId: idempotencyKey,
        providerRef: transactionId,
          stationCode,
          phoneNumber,
          message: `Unlock attempt ${attempt}/${MAX_UNLOCK_ATTEMPTS}: command succeeded but ejection not confirmed`,
          metadata: {
            imei,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
            attempt,
            maxAttempts: MAX_UNLOCK_ATTEMPTS,
            presence: lastKnownPresence,
            unlockCommandAccepted: true,
          },
        });
      } catch (unlockError) {
        // STRICT RULE: If the unlock command itself failed, NEVER treat as success.
        // A "missing" snapshot after a failed command is unreliable (stale reads, transient HeyCharge errors).
        lastUnlockError = unlockError;

        // Record presence for diagnostics only — do NOT use it to override the error
        const snapshot = await getBatterySnapshot(
          imei,
          currentBattery.battery_id,
          currentBattery.slot_id,
        );
        lastKnownPresence = snapshot.presence;

        await logError({
        type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
        transactionId: idempotencyKey,
        providerRef: transactionId,
          stationCode,
          phoneNumber,
          message: `Unlock attempt ${attempt}/${MAX_UNLOCK_ATTEMPTS}: command failed`,
          metadata: {
            imei,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
            attempt,
            maxAttempts: MAX_UNLOCK_ATTEMPTS,
            unlockCommandAccepted: false,
            presence: lastKnownPresence,
            error: unlockError instanceof Error ? unlockError.message : String(unlockError),
            presenceAfterError: lastKnownPresence === "missing"
              ? "missing_but_NOT_treated_as_success"
              : lastKnownPresence,
          },
        });
      }

      if (attempt < MAX_UNLOCK_ATTEMPTS) {
        await logError({
        type: "UNLOCK_RETRY",
        transactionId: idempotencyKey,
        providerRef: transactionId,
          stationCode,
          phoneNumber,
          message: `Retrying unlock for battery ${currentBattery.battery_id} after attempt ${attempt}`,
          metadata: {
            imei,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
            attempt,
            maxAttempts: MAX_UNLOCK_ATTEMPTS,
            retryDelayMs: UNLOCK_RETRY_DELAY_MS,
          },
        });
        await delay(UNLOCK_RETRY_DELAY_MS);
      }
    }

    // STRICT GATE: Only proceed to payment if ejection was verified via
    // a successful unlock command + confirmed "missing" polls.
    // There are NO fallback paths that convert failure into success.
    if (!verifiedEjection) {
      const failureNote = lastUnlockError
        ? lastKnownPresence === "present"
          ? `Unlock ${unlockCommandAccepted ? "verification" : "request"} failed after ${unlockAttempts} attempts, battery still present`
          : `Unlock ${unlockCommandAccepted ? "verification" : "request"} failed after ${unlockAttempts} attempts, presence=${lastKnownPresence}`
        : `Battery ejection not confirmed after ${unlockAttempts} attempts, presence=${lastKnownPresence}`;

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
          unlockCommandAccepted,
          lastKnownPresence,
          failureNote,
          lastUnlockError: lastUnlockError instanceof Error
            ? lastUnlockError.message
            : String(lastUnlockError ?? "none"),
        },
      });

      if (lastKnownPresence === "present" || lastKnownPresence === "unknown") {
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
          waafiMsg: "Payment hold cancelled — ejection not verified",
        },
      );
    }

    await transitionPaymentTransactionState({
      id: idempotencyKey,
      from: "held",
      to: "verified",
      patch: {
        verifiedAt: Date.now(),
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

    let commitResponse;
    try {
      await ensurePaymentTransactionState(idempotencyKey, "verified");
      
      // Step 7 - final assurance check
      if (!verifiedEjection) {
        throw new Error("Invariant violation: capture without verified ejection");
      }
      
      // Successfully reached commit phase — clear hold tracking
      holdTransactionId = null;
      
      commitResponse = await commitWaafiPreauthorization({
        transactionId,
        description: "Powerbank rental committed after successful eject",
      });
    } catch (error) {
      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "verified",
        to: "capture_unknown",
        patch: {
          captureUnknownAt: Date.now(),
          failureReason: `Waafi commit request failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      });

      await logError({
        type: CRITICAL_ERROR_TYPES.CAPTURE_UNKNOWN,
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: "Waafi commit request failed after verified ejection",
        metadata: {
          idempotencyKey,
          imei,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
          unlockAttempts,
          reason: error instanceof Error ? error.message : String(error),
        },
      });

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
        reason: `Battery released, but Waafi commit request failed: ${error instanceof Error ? error.message : String(error)}`,
      });

      throw new HttpError(
        502,
        "Battery was released, but payment confirmation could not be completed. Please contact support.",
        {
          transactionId,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
          unlockAttempts,
        },
      );
    }

    if (!isWaafiApproved(commitResponse)) {
      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "verified",
        to: "capture_unknown",
        patch: {
          captureUnknownAt: Date.now(),
          failureReason:
            commitResponse.responseMsg ||
            "Waafi commit not approved after verified ejection",
        },
      });

      await logError({
        type: CRITICAL_ERROR_TYPES.CAPTURE_UNKNOWN,
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: "Waafi commit response not approved after verified ejection",
        metadata: {
          idempotencyKey,
          imei,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
          unlockAttempts,
          waafiResponseMsg: commitResponse.responseMsg || null,
          waafiResponseCode:
            commitResponse.responseCode !== undefined
              ? String(commitResponse.responseCode)
              : null,
          waafiState: commitResponse.params?.state || null,
        },
      });

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
        reason: "Battery likely ejected, but Waafi commit was not approved",
      });

      throw new HttpError(
        502,
        "Battery was released, but payment confirmation could not be completed. Please contact support.",
        {
          transactionId,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
          unlockAttempts,
        },
      );
    }

    try {
      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "verified",
        to: "captured",
        patch: {
          capturedAt: Date.now(),
          providerRef: transactionId,
          rentalCreated: false,
        },
      });
    } catch (err) {
      await logError({
        type: "SYSTEM_INCONSISTENCY",
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: "Post-capture failure: transition to captured state failed",
        metadata: { error: String(err) }
      });
      throw err;
    }

    const commitIds = extractWaafiIds(commitResponse);
    const waafiAudit = mergeWaafiAuditRecords(
      preauthAudit,
      extractWaafiAudit(commitResponse),
    );

    try {
      await patchPaymentTransaction({
        id: idempotencyKey,
        patch: {
          providerRef: commitIds.transactionId || transactionId,
          providerIssuerRef: commitIds.issuerTransactionId || issuerTransactionId,
          providerReferenceId: commitIds.referenceId || referenceId || preauthReferenceId,
        },
      });
    } catch (err) {
      await logError({
        type: "SYSTEM_INCONSISTENCY",
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: "Post-capture failure: patch Waafi IDs failed",
        metadata: { error: String(err) }
      });
      throw err;
    }

    let rentalRef;
    const resolvedTransactionId = commitIds.transactionId || transactionId;
    try {
      const existingRental = await getRentalByTransactionId(resolvedTransactionId);
      if (existingRental) {
        rentalRef = { id: existingRental.id };
      } else {
      rentalRef = await createRentalLog({
        imei,
        stationCode,
        batteryId: currentBattery.battery_id,
        slotId: currentBattery.slot_id,
        phoneNumber: canonicalPhoneNumber,
        requestedPhoneNumber: phoneNumber,
        amount,
        transactionId: resolvedTransactionId,
        issuerTransactionId,
        referenceId: commitIds.referenceId || referenceId || preauthReferenceId,
        phoneAuthority,
        waafiAudit,
      });
      }
    } catch (error) {
      if (error instanceof BatteryStateConflictError) {
        await logError({
        type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
        transactionId: idempotencyKey,
        providerRef: transactionId,
          stationCode,
          phoneNumber,
          message: "Payment captured but battery already linked to another active rental",
          metadata: {
            idempotencyKey,
            imei,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
            conflictBatteryId: error.batteryId,
            activeRentalId: error.activeRentalId,
          },
        });

        await notifyPaidButNotEjected({
          phoneNumber,
          amount,
          imei,
          stationCode,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
          transactionId,
          issuerTransactionId,
          referenceId: commitIds.referenceId || referenceId || preauthReferenceId,
          unlockAttempts,
          reason: `Payment committed but battery already linked to active rental ${error.activeRentalId || "unknown"}`,
        });

        throw new HttpError(
          409,
          "Payment was confirmed, but this battery was already linked to another active rental. Please contact support.",
          {
            batteryId: error.batteryId,
            activeRentalId: error.activeRentalId,
            transactionId,
          },
        );
      }

      if (error instanceof BatteryStateConflictError) {
        // ... (previous error handled above this line)
        throw new HttpError(
          409,
          "Payment was confirmed, but this battery was already linked to another active rental. Please contact support.",
          {
            batteryId: error.batteryId,
            activeRentalId: error.activeRentalId,
            transactionId,
          },
        );
      }

      await logError({
        type: "SYSTEM_INCONSISTENCY",
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: "Post-capture failure: createRentalLog failed",
        metadata: { error: String(error) }
      });
      throw error;
    }

    try {
      await patchPaymentTransaction({
        id: idempotencyKey,
        patch: {
          rentalCreated: true,
          rentalId: rentalRef.id,
        },
      });
    } catch (err) {
      await logError({
        type: "SYSTEM_INCONSISTENCY",
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: "Post-capture failure: rentalCreated patch failed",
        metadata: { error: String(err) }
      });
      throw err;
    }

    try {
      await releaseReservation(imei, currentBattery.battery_id);
      reservedBatteryId = null;
      await updateRentalUnlockStatus(rentalRef.id, "unlocked");
    } catch (err) {
      await logError({
        type: "SYSTEM_INCONSISTENCY",
        transactionId: idempotencyKey,
        providerRef: transactionId,
        stationCode,
        phoneNumber,
        message: "Post-capture failure: updateRentalUnlockStatus failed",
        metadata: { error: String(err) }
      });
      throw err;
    }

    return {
      success: true,
      battery_id: currentBattery.battery_id,
      slot_id: currentBattery.slot_id,
      unlock,
      waafiMessage: "Battery released and payment confirmed",
      waafiResponse: commitResponse,
    };
  } catch (error) {
    if (holdCreated && holdTransactionId) {
      try {
        await cancelWaafiPreauthorization({
          transactionId: holdTransactionId,
          description: "Payment failed before ejection, automatic early exit cleanup",
        });
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
