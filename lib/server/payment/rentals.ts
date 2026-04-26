import { Timestamp } from "firebase-admin/firestore";

import { getDb } from "@/lib/server/firebase-admin";
import { normalizeBatteryId } from "@/lib/server/payment/battery-id";
import {
  BATTERY_STATE_COLLECTION,
  BatteryStateConflictError,
} from "@/lib/server/payment/battery-state";
import {
  PAYMENT_TRANSACTIONS_COLLECTION,
  logTransactionEvent,
} from "@/lib/server/payment/transactions";

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
 * Checks if a user is blocked from renting due to overdue or lost assets.
 */
export async function checkUserRestrictions(phone: string): Promise<{
  restricted: boolean;
  reason?: "ACTIVE_RENTAL_OVERDUE" | "ACTIVE_RENTAL_LOST";
}> {
  const normalizedPhone = phone.startsWith("+") ? phone : `+${phone.replace(/\D/g, "")}`;
  const db = getDb();
  
  const snapshot = await db.collection(RENTALS_COLLECTION)
    .where("phone", "==", normalizedPhone)
    .where("status", "in", ["overdue", "lost"])
    .limit(1)
    .get();

  if (snapshot.empty) {
    return { restricted: false };
  }

  const data = snapshot.docs[0].data() as RentalRecord;
  return {
    restricted: true,
    reason: data.status === "overdue" ? "ACTIVE_RENTAL_OVERDUE" : "ACTIVE_RENTAL_LOST"
  };
}

/**
 * Creates a new rental record.
 * Only called after HIGH confidence delivery verification.
 * Uses deterministic ID based on transactionId for perfect idempotency.
 */
export async function createRental(params: {
  transactionId: string;
  phone: string;
  stationId: string;
  slotId: string;
  batteryId: string;
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
  
  // Rule: 1 transaction = 1 rental (Deterministic ID)
  const rentalId = `rental_${params.transactionId}`;
  const rentalRef = db.collection(RENTALS_COLLECTION).doc(rentalId);
  
  const batteryStateRef = db
    .collection(BATTERY_STATE_COLLECTION)
    .doc(normalizedBatteryId);
  const transactionRef = db
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .doc(params.transactionId);

  await db.runTransaction(async (tx) => {
    // 1. Idempotency Check
    const existingSnap = await tx.get(rentalRef);
    if (existingSnap.exists) {
      return;
    }

    // 2. Asset Safety: Check if battery is already in an active rental
    const batteryStateSnap = await tx.get(batteryStateRef);
    const batteryState = batteryStateSnap.data() || {};

    if (
      (batteryState.status === "active" || batteryState.status === "overdue") &&
      batteryState.activeRentalId && 
      batteryState.activeRentalId !== rentalId
    ) {
       throw new BatteryStateConflictError(
        normalizedBatteryId,
        batteryState.activeRentalId
      );
    }

    const rental: RentalRecord = {
      id: rentalId,
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

    // 3. Update battery state with tracking info
    tx.set(
      batteryStateRef,
      {
        battery_id: normalizedBatteryId,
        status: "active",
        lastSeenState: "missing", // User has it now
        activeRentalId: rentalId,
        imei: params.imei || null,
        stationCode: params.stationId,
        slot_id: params.slotId,
        phoneNumber: params.phone,
        transactionId: params.transactionId,
        updatedAt: Timestamp.now(),
        consecutivePresentCount: 0, // Reset counter
      },
      { merge: true },
    );

    // 4. CROSS-DOCUMENT ATOMICITY: Link back to transaction
    tx.update(transactionRef, {
      rentalId: rentalId,
      rentalCreated: true,
      updatedAt: now,
      updatedAtTs: Timestamp.now(),
    });
  });

  return rentalId;
}

/**
 * Marks a rental as returned when a battery is detected in a slot.
 */
export async function markRentalReturned(params: {
  batteryId: string;
  returnStationId: string;
  currentState: "present" | "missing"; // Explicitly passed from caller
}) {
  const db = getDb();
  const normalizedBatteryId = normalizeBatteryId(params.batteryId) || params.batteryId;
  const now = Date.now();
  const nowTs = Timestamp.fromMillis(now);

  const batteryRef = db.collection(BATTERY_STATE_COLLECTION).doc(normalizedBatteryId);
  const rentalsCol = db.collection(RENTALS_COLLECTION);

  // 1. STATE-MACHINE SIGNAL HANDLING
  // If the battery is missing, we MUST purge any existing stability metrics 
  // to ensure a fresh 10s timer if it is re-inserted later (Test 6 Safety).
  if (params.currentState === "missing") {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(batteryRef);
      if (!snap.exists) return;
      const data = snap.data() || {};
      
      // Only update if there is something to reset to save on write costs
      if (data.presentSince || data.consecutivePresentCount || data.lastSeenState !== "missing") {
        tx.update(batteryRef, {
          presentSince: null,
          consecutivePresentCount: 0,
          lastSeenState: "missing",
          lastSeenAt: nowTs,
          updatedAt: nowTs,
        });
      }
    });
    return;
  }

  // Only proceed with return logic if battery is actually detected
  if (params.currentState !== "present") return;

  let shouldLogMismatch = false;
  let logMismatchData: any = null;
  let shouldLogSuccess = false;
  let transactionIdToLog: string | null = null;
  let rentalIdToLog: string | null = null;
  let rentalStartedAt: number = 0;

  await db.runTransaction(async (tx) => {
    // 2. FRESH ATOMIC READS (Must be inside transaction)
    const batterySnap = await tx.get(batteryRef);
    if (!batterySnap.exists) return; // Battery doc missing

    const batteryData = batterySnap.data() || {};
    const rentalId = batteryData.activeRentalId;

    if (!rentalId) {
      // No active rental associated with this battery
      return;
    }

    const rentalRef = rentalsCol.doc(rentalId);
    const rentalSnap = await tx.get(rentalRef);
    if (!rentalSnap.exists) return; // Rental record missing

    const rentalData = rentalSnap.data() as RentalRecord;
    // Only allow closing active or overdue rentals
    if (rentalData.status !== "active" && rentalData.status !== "overdue") {
      return;
    }

    transactionIdToLog = rentalData.transactionId;
    rentalIdToLog = rentalId;
    rentalStartedAt = rentalData.startedAt;

    // 4. TRANSITION GUARD (Strict Missing -> Present)
    // Only attempt to close if the battery was previously assigned (missing)
    if (batteryData.lastSeenState && batteryData.lastSeenState !== "missing") {
       // Just update heartbeat but do not close rental yet
       tx.update(batteryRef, { 
         lastSeenAt: nowTs,
         lastSeenState: "present" 
       });
       return;
    }

    // 4. OWNERSHIP GUARD: Ensure the battery in the slot matches the rental record
    // We check BOTH ways: 
    // - Does the rental doc say this battery belongs to it?
    // - Does the battery doc say it belongs to this rental?
    if (rentalData.batteryId !== normalizedBatteryId || batteryData.activeRentalId !== rentalRef.id) {
       shouldLogMismatch = true;
       logMismatchData = {
         detectedBatteryId: normalizedBatteryId,
         expectedBatteryId: rentalData.batteryId,
         detectedRentalId: batteryData.activeRentalId,
         expectedRentalId: rentalRef.id,
         stationId: params.returnStationId,
       };
       return;
    }

    // 5. TIME-BASED & COUNT-BASED DEBOUNCING
    let firstSeenAt = batteryData.presentSince?.toMillis ? batteryData.presentSince.toMillis() : batteryData.presentSince;

    // First detection: Initialize stability window timer
    if (!firstSeenAt) {
      tx.update(batteryRef, {
        consecutivePresentCount: 1,
        presentSince: nowTs,
        lastSeenAt: nowTs,
        lastSeenState: "present",
      });
      console.info(`[RETURN_STABILITY_START] Battery ${normalizedBatteryId} detected.`);
      return;
    }

    const stableDurationMs = now - firstSeenAt;
    const currentCount = (batteryData.consecutivePresentCount || 0) + 1;

    // Constraint: 10 seconds AND 2 consecutive polls
    if (currentCount < 2 || stableDurationMs < 10000) {
      tx.update(batteryRef, {
        consecutivePresentCount: currentCount,
        lastSeenAt: nowTs,
        lastSeenState: "present",
      });
      console.info(`[RETURN_DEBOUNCED] Battery ${normalizedBatteryId} stable for ${stableDurationMs}ms (Count: ${currentCount}).`);
      return;
    }

    // 6. ATOMIC COMMIT (Success)
    tx.update(rentalRef, {
      status: "returned",
      returnedAt: now,
      returnStationId: params.returnStationId,
      updatedAt: now,
    });

    // Reset full stability state for next lifecycle
    tx.update(batteryRef, {
      status: "available",
      lastSeenState: "present",
      activeRentalId: null,
      consecutivePresentCount: 0,
      presentSince: null,
      lastSeenAt: nowTs,
      updatedAt: nowTs,
    });
    
    shouldLogSuccess = true;
  });

  // 7. Side Effects (Outside transaction to prevent duplicates on retry)
  if (shouldLogMismatch && transactionIdToLog) {
    await logTransactionEvent(transactionIdToLog, "RETURN_REJECTED_OWNERSHIP_MISMATCH", logMismatchData, "IMPORTANT");
  }

  if (shouldLogSuccess && transactionIdToLog && rentalIdToLog) {
    await logTransactionEvent(transactionIdToLog, "RENTAL_RETURN_CONFIRMED", {
      rentalId: rentalIdToLog,
      batteryId: normalizedBatteryId,
      stationId: params.returnStationId,
      durationMs: now - rentalStartedAt,
    }, "IMPORTANT");
    console.info(`[RENTAL_RETURNED] Rental: ${rentalIdToLog}, Battery: ${normalizedBatteryId}`);
  }
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
    const data = doc.data() as RentalRecord;
    const elapsedSinceDue = now - data.dueAt;
    
    // Stage 2: Overdue (> 0ms past due)
    // Stage 3/4: Lost (> 24 hours past due)
    const isLost = elapsedSinceDue > 24 * 60 * 60 * 1000;
    const nextStatus = isLost ? "lost" : "overdue";

    if (data.status !== nextStatus) {
      batch.update(doc.ref, {
        status: nextStatus,
        updatedAt: now,
      });
      
      if (data.batteryId) {
        batch.update(db.collection(BATTERY_STATE_COLLECTION).doc(data.batteryId), {
          status: nextStatus,
          updatedAt: Timestamp.now(),
        });
      }
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
    .where("status", "in", ["active", "overdue", "lost"])
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
    .where("status", "in", ["active", "overdue", "lost"])
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

