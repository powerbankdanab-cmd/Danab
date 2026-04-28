import {
  acquirePhonePaymentLock,
  releasePhonePaymentLock,
  releaseReservation,
  reserveBattery,
} from "@/lib/server/payment/battery-lock";
import { logError } from "@/lib/server/alerts/log-error";
import { HttpError } from "@/lib/server/payment/errors";
import {
  getAvailableBattery,
  queryStationBatteries,
  releaseBattery,
  MIN_AVAILABLE_BATTERY_PERCENT,
} from "@/lib/server/payment/heycharge";
import { isPhoneBlacklisted } from "@/lib/server/payment/blacklist";
import {
  createRental,
  getRentalByTransactionId,
  hasActiveRentalForPhone,
} from "@/lib/server/payment/rentals";
import { getActiveStationCode, getStationImei } from "@/lib/server/payment/station";
import { getStationConfigByCode } from "@/lib/server/station-config";
import { PaymentInput, PaymentPayload } from "@/lib/server/payment/types";
import {
  createOrGetPaymentTransaction,
  patchPaymentTransaction,
  transitionPaymentTransactionState,
} from "@/lib/server/payment/transactions";
import {
  extractWaafiAudit,
  extractWaafiIds,
  isWaafiApproved,
  requestWaafiDirectPayment,
} from "@/lib/server/payment/waafi";
import { verifyDeliveryWithConfidence } from "@/lib/server/payment/delivery-verification";

function asMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export async function processPayment(input: PaymentInput): Promise<PaymentPayload> {
  const phoneNumber = input.phoneNumber.replace(/\D/g, "");
  const { amount } = input;
  const requestedStationCode = String(input.stationCode || "").replace(/\D/g, "");
  const idempotencyKey = String(input.idempotencyKey || "").trim();

  if (!idempotencyKey) {
    throw new HttpError(400, "Missing idempotency key");
  }
  if (!phoneNumber || Number.isNaN(amount) || amount <= 0) {
    throw new HttpError(400, "Missing phoneNumber or valid amount");
  }

  if (await isPhoneBlacklisted(phoneNumber)) {
    throw new HttpError(403, "You are blocked from renting. Please contact support.");
  }
  const normalizedPhoneWithCountry = phoneNumber.startsWith("252")
    ? `+${phoneNumber}`
    : `+252${phoneNumber}`;

  if (await hasActiveRentalForPhone(normalizedPhoneWithCountry)) {
    throw new HttpError(409, "You already have an active rental. Please return it before renting another battery.");
  }

  const requestedStationConfig = requestedStationCode
    ? getStationConfigByCode(requestedStationCode)
    : null;
  if (requestedStationCode && !requestedStationConfig) {
    throw new HttpError(400, "Invalid station code");
  }

  const imei = requestedStationConfig?.imei || (await getStationImei());
  const stationCode = requestedStationConfig?.code || (await getActiveStationCode());

  const txRecord = await createOrGetPaymentTransaction({
    id: idempotencyKey,
    phone: phoneNumber,
    station: stationCode,
    amount,
  });

  if (!txRecord.created) {
    if (txRecord.record.status === "captured" && txRecord.record.rentalCreated) {
      return {
        success: true,
        message: "Payment already processed",
        transactionId: txRecord.record.providerRef || txRecord.record.id,
      };
    }
    throw new HttpError(409, "This payment is already being processed. Please wait.", {
      transactionId: txRecord.record.id,
      status: txRecord.record.status,
    });
  }

  const phoneLockAcquired = await acquirePhonePaymentLock(phoneNumber);
  if (!phoneLockAcquired) {
    throw new HttpError(409, "A payment for this phone is already being processed. Please wait a moment before trying again.");
  }

  let reservedBatteryId: string | null = null;

  try {
    // 1) Station online precheck
    let stationBatteries;
    try {
      stationBatteries = await queryStationBatteries(imei);
    } catch (error) {
      await logError({
        type: "STATION_OFFLINE",
        transactionId: idempotencyKey,
        stationCode,
        phoneNumber,
        message: "Station offline before payment request",
        metadata: { imei, error: asMessage(error) },
      });
      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "initiated",
        to: "failed",
        patch: { failedAt: Date.now(), failureReason: "STATION_OFFLINE", failureStage: "payment" },
      });
      throw new HttpError(503, "Station is offline. Please try another station.");
    }

    // 2) Inventory check
    if (!stationBatteries || stationBatteries.length === 0) {
      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "initiated",
        to: "failed",
        patch: { failedAt: Date.now(), failureReason: "NO_BATTERIES", failureStage: "payment" },
      });
      throw new HttpError(400, "No batteries available at this station.");
    }

    // 3) Quality check (>= 60%)
    const hasAboveThreshold = stationBatteries.some((b) => {
      const cap = Number.parseInt(String(b.battery_capacity || "0"), 10);
      return Number.isFinite(cap) && cap >= MIN_AVAILABLE_BATTERY_PERCENT;
    });
    if (!hasAboveThreshold) {
      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "initiated",
        to: "failed",
        patch: { failedAt: Date.now(), failureReason: "LOW_BATTERY", failureStage: "payment" },
      });
      throw new HttpError(400, `All batteries are below ${MIN_AVAILABLE_BATTERY_PERCENT}%. Please wait while charging.`);
    }

    const candidate = await getAvailableBattery(imei);
    if (!candidate) {
      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "initiated",
        to: "failed",
        patch: { failedAt: Date.now(), failureReason: "BATTERY_BUSY", failureStage: "payment" },
      });
      throw new HttpError(409, "No battery is currently rentable. Please retry.");
    }

    // 4) Soft reservation BEFORE payment
    const reserved = await reserveBattery(imei, candidate.battery_id, phoneNumber);
    if (!reserved) {
      throw new HttpError(409, "Battery just got reserved by another user. Please retry.");
    }
    reservedBatteryId = candidate.battery_id;

    await patchPaymentTransaction({
      id: idempotencyKey,
      patch: {
        delivery: {
          imei,
          stationCode,
          batteryId: candidate.battery_id,
          slotId: candidate.slot_id,
          phoneAuthority: "requested_phone_only",
          unlockAttempts: 0,
          requestedPhoneNumber: phoneNumber,
          canonicalPhoneNumber: phoneNumber,
        },
      },
    });

    // 5) Direct payment request (no preauth/hold)
    const waafiResponse = await requestWaafiDirectPayment({
      phoneNumber,
      amount,
      referenceId: idempotencyKey,
    });

    const waafiAudit = extractWaafiAudit(waafiResponse);
    const ids = extractWaafiIds(waafiResponse);
    const providerRef = ids.transactionId || null;

    if (!isWaafiApproved(waafiResponse)) {
      await releaseReservation(imei, candidate.battery_id);
      reservedBatteryId = null;

      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "initiated",
        to: "failed",
        patch: {
          failedAt: Date.now(),
          failureReason: waafiResponse.responseMsg || "PAYMENT_NOT_APPROVED",
          failureStage: "payment",
          providerRef,
          providerIssuerRef: ids.issuerTransactionId,
          providerReferenceId: ids.referenceId || idempotencyKey,
          waafiAudit,
        },
      });

      throw new HttpError(402, "Payment was not approved.");
    }

    await transitionPaymentTransactionState({
      id: idempotencyKey,
      from: "initiated",
      to: "paid",
      patch: {
        providerRef,
        providerIssuerRef: ids.issuerTransactionId,
        providerReferenceId: ids.referenceId || idempotencyKey,
        waafiAudit,
      },
    });

    // 6) Station isolation check before eject
    const latest = await queryStationBatteries(imei);
    const stillThere = latest.find(
      (b) => b.battery_id === candidate.battery_id && b.slot_id === candidate.slot_id,
    );
    if (!stillThere) {
      await logError({
        type: "STATION_ISOLATION_MISMATCH",
        transactionId: idempotencyKey,
        stationCode,
        phoneNumber,
        message: "Reserved battery no longer present in requested station before eject",
        metadata: { imei, batteryId: candidate.battery_id, slotId: candidate.slot_id, providerRef },
      });
      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "paid",
        to: "failed",
        patch: { failedAt: Date.now(), failureReason: "STATION_ISOLATION_MISMATCH", failureStage: "unlock" },
      });
      throw new HttpError(409, "Battery changed before ejection.");
    }

    await transitionPaymentTransactionState({
      id: idempotencyKey,
      from: "paid",
      to: "held",
      patch: { heldAt: Date.now(), unlockStarted: true },
    });

    // 7) Eject exact battery
    const unlock = await releaseBattery({
      imei,
      batteryId: candidate.battery_id,
      slotId: candidate.slot_id,
    });

    // 8) Verify delivery HIGH only
    const verification = await verifyDeliveryWithConfidence(
      imei,
      candidate.battery_id,
      candidate.slot_id,
      {
        stationCode,
        phoneNumber,
        transactionId: idempotencyKey,
      },
      Date.now(),
    );

    if (verification.confidence !== "HIGH") {
      await logError({
        type: "VERIFICATION_FAILED",
        transactionId: idempotencyKey,
        stationCode,
        phoneNumber,
        message: "Battery ejection confidence is not HIGH after direct payment",
        metadata: {
          confidence: verification.confidence,
          snapshots: verification.snapshots,
          providerRef,
          batteryId: candidate.battery_id,
          slotId: candidate.slot_id,
        },
      });

      await transitionPaymentTransactionState({
        id: idempotencyKey,
        from: "held",
        to: "failed",
        patch: { failedAt: Date.now(), failureReason: "VERIFICATION_FAILED", failureStage: "verification" },
      });
      throw new HttpError(502, "Battery did not eject.");
    }

    await transitionPaymentTransactionState({
      id: idempotencyKey,
      from: "held",
      to: "verified",
      patch: { verifiedAt: Date.now(), unlockCompleted: true, unlock },
    });

    await transitionPaymentTransactionState({
      id: idempotencyKey,
      from: "verified",
      to: "captured",
      patch: { capturedAt: Date.now(), captureCompleted: true, rentalCreated: false },
    });

    const rentalTransactionId = providerRef || idempotencyKey;
    const existingRental = await getRentalByTransactionId(rentalTransactionId);
    const rentalRef = existingRental
      ? { id: existingRental.id }
      : { id: await createRental({
        transactionId: rentalTransactionId,
        phone: normalizedPhoneWithCountry,
        stationId: stationCode,
        slotId: candidate.slot_id,
        batteryId: candidate.battery_id,
        imei,
        requestedPhoneNumber: phoneNumber,
        phoneAuthority: "requested_phone_only",
        amount,
        issuerTransactionId: ids.issuerTransactionId || null,
        referenceId: ids.referenceId || idempotencyKey,
      }) };

    await patchPaymentTransaction({
      id: idempotencyKey,
      patch: { rentalCreated: true, rentalId: rentalRef.id },
    });

    await releaseReservation(imei, candidate.battery_id);
    reservedBatteryId = null;

    return {
      success: true,
      battery_id: candidate.battery_id,
      slot_id: candidate.slot_id,
      unlock,
      waafiMessage: "Battery released and payment confirmed",
      waafiResponse,
    };
  } catch (error) {
    await logError({
      type: "PAYMENT_FLOW_FAILED",
      transactionId: idempotencyKey,
      stationCode,
      phoneNumber,
      message: "Payment flow failed in direct-payment mode",
      metadata: { error: asMessage(error) },
    });
    throw error;
  } finally {
    if (reservedBatteryId) {
      await releaseReservation(imei, reservedBatteryId);
    }
    await releasePhonePaymentLock(phoneNumber);
  }
}
