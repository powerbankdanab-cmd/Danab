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
  isSpecificBatteryReadyForRental,
  markProblemSlot,
  MIN_AVAILABLE_BATTERY_PERCENT,
  queryStationBatteries,
  releaseBattery,
} from "@/lib/server/payment/heycharge";
import { isPhoneBlacklisted } from "@/lib/server/payment/blacklist";
import {
  createRentalLog,
  hasActiveRentalForPhone,
  isDuplicateTransaction,
  updateRentalUnlockStatus,
} from "@/lib/server/payment/rentals";
import { getActiveStationCode, getStationImei } from "@/lib/server/payment/station";
import { getStationConfigByCode } from "@/lib/server/station-config";
import { notifyPaidButNotEjected } from "@/lib/server/payment/telegram";
import { PaymentInput, PaymentPayload } from "@/lib/server/payment/types";
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
const UNLOCK_VERIFY_POLL_MS = [250, 350, 400] as const;

type BatteryPresence = "present" | "missing" | "unknown";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkBatteryPresence(
  imei: string,
  batteryId: string,
  slotId: string,
): Promise<BatteryPresence> {
  try {
    const stationBatteries = await queryStationBatteries(imei);
    const stillThere = stationBatteries.some(
      (battery) =>
        normalizeBatteryId(battery.battery_id) === normalizeBatteryId(batteryId) &&
        battery.slot_id === slotId,
    );

    return stillThere ? "present" : "missing";
  } catch (error) {
    console.warn(
      "Failed to recheck slot status after unlock attempt:",
      error instanceof Error ? error.message : error,
    );
    return "unknown";
  }
}

async function verifyEjectionAfterUnlock(
  imei: string,
  batteryId: string,
  slotId: string,
): Promise<BatteryPresence> {
  for (const waitMs of UNLOCK_VERIFY_POLL_MS) {
    await delay(waitMs);
    const presence = await checkBatteryPresence(imei, batteryId, slotId);
    if (presence === "missing") {
      return "missing";
    }
    if (presence === "present") {
      return "present";
    }
  }

  return "unknown";
}

export async function processPayment(
  input: PaymentInput,
): Promise<PaymentPayload> {
  const phoneNumber = input.phoneNumber.replace(/\D/g, "");
  const { amount } = input;
  const requestedStationCode = String(input.stationCode || "").replace(/\D/g, "");

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
  const phoneLockAcquired = await acquirePhonePaymentLock(phoneNumber);
  if (!phoneLockAcquired) {
    throw new HttpError(
      409,
      "A payment for this phone is already being processed. Please wait a moment before trying again.",
    );
  }

  let reservedBatteryId: string | null = null;

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
      console.warn(
        `Reserve attempt ${attempt + 1}: battery ${candidate.battery_id} already taken, trying next`,
      );
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

    const duplicate = await isDuplicateTransaction(transactionId);
    if (duplicate) {
      try {
        await cancelWaafiPreauthorization({
          transactionId,
          description: "Duplicate preauthorization hold cancelled",
        });
      } catch (error) {
        console.warn(
          "Failed to cancel duplicate preauthorization hold:",
          error instanceof Error ? error.message : error,
        );
      }

      return {
        success: true,
        message: "Payment already processed",
        transactionId,
      };
    }

    let unlock: unknown = null;
    let unlockAttempts = 0;
    let lastUnlockError: unknown = null;
    const currentBattery = battery;
    let lastKnownPresence: BatteryPresence = "unknown";
    let unlockCommandAccepted = false;

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
        );

        if (lastKnownPresence === "missing") {
          lastUnlockError = null;
          break;
        }

        lastUnlockError = new Error(
          lastKnownPresence === "present"
            ? "Battery unlock command succeeded, but battery is still present in slot"
            : "Battery unlock command succeeded, but eject could not be verified",
        );

        console.error(
          `Battery still not confirmed ejected after unlock success on attempt ${attempt}/${MAX_UNLOCK_ATTEMPTS} for battery=${currentBattery.battery_id} phone=${phoneNumber} txn=${transactionId}; presence=${lastKnownPresence}`,
        );
      } catch (unlockError) {
        lastUnlockError = unlockError;
        console.error(
          `Battery unlock failed on attempt ${attempt}/${MAX_UNLOCK_ATTEMPTS} for battery=${currentBattery.battery_id} phone=${phoneNumber} txn=${transactionId}:`,
          unlockError instanceof Error ? unlockError.message : unlockError,
        );

        lastKnownPresence = await checkBatteryPresence(
          imei,
          currentBattery.battery_id,
          currentBattery.slot_id,
        );

        if (lastKnownPresence === "missing") {
          console.error(
            `Battery ${currentBattery.battery_id} is no longer in slot ${currentBattery.slot_id} after unlock error — treating as successful eject`,
          );
          lastUnlockError = null;
          unlock = null;
          break;
        }
      }

      if (attempt < MAX_UNLOCK_ATTEMPTS) {
        console.warn(
          `Battery ${currentBattery.battery_id} still not confirmed ejected after attempt ${attempt}; retrying in ${UNLOCK_RETRY_DELAY_MS}ms`,
        );
        await delay(UNLOCK_RETRY_DELAY_MS);
      }
    }

    if (lastUnlockError) {
      if (lastKnownPresence !== "present") {
        lastKnownPresence = await checkBatteryPresence(
          imei,
          currentBattery.battery_id,
          currentBattery.slot_id,
        );
      }

      if (lastKnownPresence === "missing") {
        console.error(
          `Battery ${currentBattery.battery_id} not in slot ${currentBattery.slot_id} after unlock error — likely ejected successfully`,
        );
        lastUnlockError = null;
        unlock = null;
      }

      if (lastUnlockError) {
        const failureNote =
          lastKnownPresence === "present"
            ? `Unlock ${unlockCommandAccepted ? "verification" : "request"} failed after ${unlockAttempts} attempts, battery still present`
            : `Unlock ${unlockCommandAccepted ? "verification" : "request"} failed after ${unlockAttempts} attempts, slot status could not be rechecked`;

        if (lastKnownPresence === "present") {
          try {
            await markProblemSlot(
              imei,
              currentBattery.slot_id,
              currentBattery.battery_id,
              failureNote,
            );
          } catch (recoveryError) {
            console.error(
              "Failed to mark problem slot after preauthorization cancel path:",
              recoveryError instanceof Error
                ? recoveryError.message
                : recoveryError,
            );
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
            description: "Battery release failed, hold cancelled",
          });

          if (!isWaafiApproved(cancelResponse)) {
            cancelError = new Error(
              cancelResponse.responseMsg || "Waafi cancel was not approved",
            );
          }
        } catch (error) {
          cancelError = error;
        }

        if (cancelError) {
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

        throw new HttpError(
          502,
          "Battery could not be released. Payment hold was cancelled.",
          {
            transactionId,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
            unlockAttempts,
            waafiMsg: "Payment hold cancelled after eject failure",
          },
        );
      }
    }

    let commitResponse;
    try {
      commitResponse = await commitWaafiPreauthorization({
        transactionId,
        description: "Powerbank rental committed after successful eject",
      });
    } catch (error) {
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

    const commitIds = extractWaafiIds(commitResponse);
    const waafiAudit = mergeWaafiAuditRecords(
      preauthAudit,
      extractWaafiAudit(commitResponse),
    );

    let rentalRef;
    try {
      rentalRef = await createRentalLog({
        imei,
        stationCode,
        batteryId: currentBattery.battery_id,
        slotId: currentBattery.slot_id,
        phoneNumber: canonicalPhoneNumber,
        requestedPhoneNumber: phoneNumber,
        amount,
        transactionId: commitIds.transactionId || transactionId,
        issuerTransactionId,
        referenceId: commitIds.referenceId || referenceId || preauthReferenceId,
        phoneAuthority,
        waafiAudit,
      });
    } catch (error) {
      if (error instanceof BatteryStateConflictError) {
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

      throw error;
    }

    await releaseReservation(imei, currentBattery.battery_id);
    reservedBatteryId = null;
    await updateRentalUnlockStatus(rentalRef.id, "unlocked");

    return {
      success: true,
      battery_id: currentBattery.battery_id,
      slot_id: currentBattery.slot_id,
      unlock,
      waafiMessage: "Battery released and payment confirmed",
      waafiResponse: commitResponse,
    };
  } finally {
    if (reservedBatteryId) {
      await releaseReservation(imei, reservedBatteryId);
    }
    await releasePhonePaymentLock(phoneNumber);
  }
}
