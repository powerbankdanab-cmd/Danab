import { Timestamp } from "firebase-admin/firestore";

import { getDb } from "@/lib/server/firebase-admin";
import { normalizeBatteryId } from "@/lib/server/payment/battery-id";
import {
  BATTERY_STATE_COLLECTION,
  BatteryStateConflictError,
  clearBatteryStateForRental,
  getClaimedBatteryIds,
} from "@/lib/server/payment/battery-state";

export const RENTALS_COLLECTION = "rentalsTrans";

export async function isDuplicateTransaction(transactionId: string) {
  const snapshot = await getDb()
    .collection(RENTALS_COLLECTION)
    .where("transactionId", "==", transactionId)
    .limit(1)
    .get();

  return !snapshot.empty;
}

export async function createRentalLog({
  imei,
  stationCode,
  batteryId,
  slotId,
  phoneNumber,
  requestedPhoneNumber,
  amount,
  transactionId,
  issuerTransactionId,
  referenceId,
  phoneAuthority,
  waafiAudit,
}: {
  imei: string;
  stationCode: string;
  batteryId: string;
  slotId: string;
  phoneNumber: string;
  requestedPhoneNumber?: string;
  amount: number;
  transactionId: string | null;
  issuerTransactionId: string | null;
  referenceId: string | null;
  phoneAuthority?: string;
  waafiAudit?: Record<string, unknown>;
}) {
  const db = getDb();
  const now = Timestamp.now();
  const normalizedBatteryId = normalizeBatteryId(batteryId) || batteryId;
  const resolvedRequestedPhoneNumber = requestedPhoneNumber || phoneNumber;
  const rentalRef = db.collection(RENTALS_COLLECTION).doc();
  const batteryStateRef = db
    .collection(BATTERY_STATE_COLLECTION)
    .doc(normalizedBatteryId);

  await db.runTransaction(async (tx) => {
    const batteryStateSnap = await tx.get(batteryStateRef);
    const batteryState = batteryStateSnap.data() || {};

    if (
      String(batteryState.status || "").toLowerCase() === "rented" &&
      String(batteryState.activeRentalId || "").trim().length > 0
    ) {
      throw new BatteryStateConflictError(
        normalizedBatteryId,
        String(batteryState.activeRentalId || ""),
      );
    }

    tx.set(rentalRef, {
      imei,
      stationCode,
      battery_id: normalizedBatteryId,
      slot_id: slotId,
      // Write-once customer phone captured from the approved payment request.
      requestedPhoneNumber: resolvedRequestedPhoneNumber,
      phoneNumber,
      phoneAuthority: phoneAuthority || "requested_phone_only",
      amount,
      status: "rented",
      unlockStatus: "pending",
      transactionId,
      issuerTransactionId,
      referenceId,
      ...waafiAudit,
      timestamp: now,
    });

    tx.set(
      batteryStateRef,
      {
        battery_id: normalizedBatteryId,
        imei,
        stationCode,
        slot_id: slotId,
        activeRentalId: rentalRef.id,
        phoneNumber,
        requestedPhoneNumber: resolvedRequestedPhoneNumber,
        phoneAuthority: phoneAuthority || "requested_phone_only",
        transactionId,
        issuerTransactionId,
        referenceId,
        amount,
        status: "rented",
        claimedAt: batteryState.claimedAt || now,
        updatedAt: now,
        waafiAccountNo:
          typeof waafiAudit?.waafiAccountNo === "string"
            ? waafiAudit.waafiAccountNo
            : null,
        waafiConfirmedPhoneNumber:
          typeof waafiAudit?.waafiConfirmedPhoneNumber === "string"
            ? waafiAudit.waafiConfirmedPhoneNumber
            : null,
      },
      { merge: true },
    );
  });

  return rentalRef;
}

export async function updateRentalUnlockStatus(
  rentalId: string,
  unlockStatus: "unlocked" | "unlock_failed",
) {
  return getDb().collection(RENTALS_COLLECTION).doc(rentalId).update({
    unlockStatus,
    unlockUpdatedAt: Timestamp.now(),
  });
}

export async function markRentalReturnedAfterFailedUnlock(
  rentalId: string,
  batteryId: string,
  note: string,
) {
  await getDb().collection(RENTALS_COLLECTION).doc(rentalId).update({
    status: "returned",
    returnedAt: Timestamp.now(),
    note,
  });

  await clearBatteryStateForRental({
    batteryId,
    rentalId,
    note,
  });
}

/**
 * Get battery IDs from the provided candidate list that currently have any
 * active rental (status="rented"), regardless of which station created it.
 * This prevents cross-station duplicate assignment if a battery was returned
 * to a different station before the old rental got closed.
 */
export async function getActiveRentedBatteryIds(
  batteryIds: string[],
): Promise<Set<string>> {
  const uniqueBatteryIds = Array.from(
    new Set(batteryIds.map(normalizeBatteryId).filter(Boolean)),
  );

  if (uniqueBatteryIds.length === 0) {
    return new Set<string>();
  }

  const activeIds = await getClaimedBatteryIds(uniqueBatteryIds);
  const candidateIds = new Set(uniqueBatteryIds);
  const snapshot = await getDb()
    .collection(RENTALS_COLLECTION)
    .where("status", "==", "rented")
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const normalizedBatteryId = normalizeBatteryId(data.battery_id);
    if (
      normalizedBatteryId &&
      candidateIds.has(normalizedBatteryId) &&
      !activeIds.has(normalizedBatteryId)
    ) {
      activeIds.add(normalizedBatteryId);
    }
  }

  return activeIds;
}

/**
 * Check whether this phone number already has any active rental.
 * Uses a single-field query so no extra composite index is required.
 */
export async function hasActiveRentalForPhone(
  phoneNumber: string,
): Promise<boolean> {
  const snapshot = await getDb()
    .collection(RENTALS_COLLECTION)
    .where("status", "==", "rented")
    .get();

  const normalizedPhone = String(phoneNumber || "").replace(/\D/g, "");

  return snapshot.docs.some((doc) => {
    const data = doc.data();
    const requestedPhone = String(data.requestedPhoneNumber || "").replace(
      /\D/g,
      "",
    );
    const waafiPhone = String(data.waafiConfirmedPhoneNumber || "").replace(
      /\D/g,
      "",
    );
    const storedPhone = String(data.phoneNumber || "").replace(/\D/g, "");

    return (
      requestedPhone === normalizedPhone ||
      waafiPhone === normalizedPhone ||
      storedPhone === normalizedPhone
    );
  });
}
