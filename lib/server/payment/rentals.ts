import { Timestamp } from "firebase-admin/firestore";

import { getDb } from "@/lib/server/firebase-admin";
import { normalizeBatteryId } from "@/lib/server/payment/battery-id";
import {
  BATTERY_STATE_COLLECTION,
  BatteryStateConflictError,
} from "@/lib/server/payment/battery-state";

export type RentalStatus = "active" | "returned" | "overdue" | "lost";

export interface RentalRecord {
  id: string;
  transactionId: string;
  phone: string;
  stationId: string;
  slotId: string;
  batteryId: string;
  status: RentalStatus;
  startedAt: number;
  dueAt: number;
  returnedAt?: number | null;
  returnStationId?: string | null;
  verificationConfidence: "HIGH";
  penaltyApplied: boolean;
  createdAt: number;
  updatedAt: number;
}

export const RENTALS_COLLECTION = "rentals";
const RENTAL_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours

export async function isDuplicateTransaction(transactionId: string) {
  const snapshot = await getDb()
    .collection(RENTALS_COLLECTION)
    .where("transactionId", "==", transactionId)
    .limit(1)
    .get();

  return !snapshot.empty;
}

export async function getRentalByTransactionId(transactionId: string) {
  const snapshot = await getDb()
    .collection(RENTALS_COLLECTION)
    .where("transactionId", "==", transactionId)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  return { id: doc.id, ...(doc.data() as Omit<RentalRecord, "id">) };
}

/**
 * Creates a new rental record.
 * Only called after HIGH confidence delivery verification.
 */
export async function createRental(params: {
  transactionId: string;
  phone: string;
  stationId: string;
  slotId: string;
  batteryId: string;
  // Metadata for battery_state sync
  imei?: string;
  phoneAuthority?: string;
  requestedPhoneNumber?: string;
  amount?: number;
  issuerTransactionId?: string | null;
  referenceId?: string | null;
}): Promise<string> {
  const db = getDb();
  const now = Date.now();
  const normalizedBatteryId = normalizeBatteryId(params.batteryId) || params.batteryId;
  
  const rentalRef = db.collection(RENTALS_COLLECTION).doc();
  const batteryStateRef = db
    .collection(BATTERY_STATE_COLLECTION)
    .doc(normalizedBatteryId);

  await db.runTransaction(async (tx) => {
    // 1. Check for existing active rental for this battery (Asset safety)
    const batteryStateSnap = await tx.get(batteryStateRef);
    const batteryState = batteryStateSnap.data() || {};

    if (
      batteryState.status === "rented" || 
      batteryState.status === "active"
    ) {
      if (batteryState.activeRentalId) {
         throw new BatteryStateConflictError(
          normalizedBatteryId,
          batteryState.activeRentalId
        );
      }
    }

    // 2. Check if transaction already has a rental (Idempotency)
    const existingRentalSnap = await tx.get(
      db.collection(RENTALS_COLLECTION)
        .where("transactionId", "==", params.transactionId)
        .limit(1)
    );
    
    if (!existingRentalSnap.empty) {
      const existing = existingRentalSnap.docs[0];
      return existing.id;
    }

    const rental: Omit<RentalRecord, "id"> = {
      transactionId: params.transactionId,
      phone: params.phone,
      stationId: params.stationId,
      slotId: params.slotId,
      batteryId: normalizedBatteryId,
      status: "active",
      startedAt: now,
      dueAt: now + RENTAL_DURATION_MS,
      returnedAt: null,
      returnStationId: null,
      verificationConfidence: "HIGH",
      penaltyApplied: false,
      createdAt: now,
      updatedAt: now,
    };

    tx.set(rentalRef, rental);

    // 3. Update battery state for global tracking (Keep existing fields for compatibility)
    tx.set(
      batteryStateRef,
      {
        battery_id: normalizedBatteryId,
        imei: params.imei || null,
        stationCode: params.stationId,
        slot_id: params.slotId,
        activeRentalId: rentalRef.id,
        phoneNumber: params.phone,
        requestedPhoneNumber: params.requestedPhoneNumber || params.phone,
        phoneAuthority: params.phoneAuthority || "requested_phone_only",
        transactionId: params.transactionId,
        issuerTransactionId: params.issuerTransactionId || null,
        referenceId: params.referenceId || null,
        amount: params.amount || 0,
        status: "active", // New status
        claimedAt: batteryState.claimedAt || Timestamp.now(),
        updatedAt: Timestamp.now(),
      },
      { merge: true },
    );
  });

  return rentalRef.id;
}

/**
 * Marks a rental as returned when a battery is detected in a slot.
 */
export async function markRentalReturned(params: {
  batteryId: string;
  returnStationId: string;
}) {
  const db = getDb();
  const normalizedBatteryId = normalizeBatteryId(params.batteryId) || params.batteryId;
  const now = Date.now();

  // Find the active rental for this battery
  const snapshot = await db
    .collection(RENTALS_COLLECTION)
    .where("batteryId", "==", normalizedBatteryId)
    .where("status", "in", ["active", "overdue"])
    .limit(1)
    .get();

  if (snapshot.empty) {
    console.warn(`[RETURN_IGNORED] No active rental found for battery: ${normalizedBatteryId}`);
    return;
  }

  const rentalDoc = snapshot.docs[0];
  const rentalId = rentalDoc.id;

  await db.runTransaction(async (tx) => {
    tx.update(rentalDoc.ref, {
      status: "returned",
      returnedAt: now,
      returnStationId: params.returnStationId,
      updatedAt: now,
    });

    // Clear battery state
    tx.update(db.collection(BATTERY_STATE_COLLECTION).doc(normalizedBatteryId), {
      status: "available",
      activeRentalId: null,
      updatedAt: Timestamp.now(),
    });
  });

  console.info(`[RENTAL_RETURNED] Rental: ${rentalId}, Battery: ${normalizedBatteryId}`);
}

/**
 * Periodic task to flag overdue rentals.
 */
export async function markOverdueRentals() {
  const db = getDb();
  const now = Date.now();

  const snapshot = await db
    .collection(RENTALS_COLLECTION)
    .where("status", "==", "active")
    .where("dueAt", "<", now)
    .get();

  if (snapshot.empty) return;

  const batch = db.batch();
  for (const doc of snapshot.docs) {
    batch.update(doc.ref, {
      status: "overdue",
      updatedAt: now,
    });
    
    // Also update battery state to overdue
    const data = doc.data();
    if (data.batteryId) {
      batch.update(db.collection(BATTERY_STATE_COLLECTION).doc(data.batteryId), {
        status: "overdue",
        updatedAt: Timestamp.now(),
      });
    }
  }

  await batch.commit();
  console.info(`[OVERDUE_CRON] Marked ${snapshot.size} rentals as overdue`);
}

// Legacy helpers (updated to use new collection)
export async function updateRentalUnlockStatus(
  rentalId: string,
  unlockStatus: "unlocked" | "unlock_failed",
) {
  return getDb().collection(RENTALS_COLLECTION).doc(rentalId).update({
    unlockStatus,
    unlockUpdatedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

export async function hasActiveRentalForPhone(
  phoneNumber: string,
): Promise<boolean> {
  const normalizedPhone = String(phoneNumber || "").replace(/\D/g, "");
  const snapshot = await getDb()
    .collection(RENTALS_COLLECTION)
    .where("phone", "==", `+${normalizedPhone}`) // Assuming stored with +
    .where("status", "in", ["active", "overdue"])
    .limit(1)
    .get();

  return !snapshot.empty;
}

/**
 * Get battery IDs from the provided candidate list that currently have any
 * active rental (status="active" or "overdue").
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

  const activeIds = new Set<string>();
  const snapshot = await getDb()
    .collection(RENTALS_COLLECTION)
    .where("status", "in", ["active", "overdue"])
    .get();

  const candidateIds = new Set(uniqueBatteryIds);
  for (const doc of snapshot.docs) {
    const data = doc.data() as RentalRecord;
    const normalizedId = normalizeBatteryId(data.batteryId);
    if (normalizedId && candidateIds.has(normalizedId)) {
      activeIds.add(normalizedId);
    }
  }

  return activeIds;
}

