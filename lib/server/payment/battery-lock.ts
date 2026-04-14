import { Timestamp } from "firebase-admin/firestore";

import { getDb } from "@/lib/server/firebase-admin";
import { normalizeBatteryId } from "@/lib/server/payment/battery-id";

/**
 * Reservation TTL in milliseconds (2 minutes).
 * If a reservation is older than this, it is considered expired and can be overwritten.
 * This prevents stuck reservations from permanently blocking a battery.
 */
const RESERVATION_TTL_MS = 2 * 60 * 1000;
const PHONE_PAYMENT_LOCK_TTL_MS = 6 * 60 * 1000;

/**
 * Build a deterministic document ID for a battery reservation.
 * Using a deterministic ID means every battery has a single lock document.
 */
function reservationDocId(imei: string, batteryId: string): string {
  return `${imei}_${normalizeBatteryId(batteryId) || batteryId}`;
}

function phonePaymentLockDocId(phoneNumber: string): string {
  return encodeURIComponent(phoneNumber);
}

/**
 * Atomically reserve a battery so no other concurrent request can claim it.
 *
 * Uses Firestore runTransaction to:
 * 1. Check if a reservation doc already exists and is still valid (not expired).
 * 2. If no valid reservation exists, create/overwrite one for this phone number.
 * 3. If a valid reservation exists, the battery is taken.
 *
 * Returns true if the reservation was acquired, false if the battery is already taken.
 */
export async function reserveBattery(
  imei: string,
  batteryId: string,
  phoneNumber: string,
): Promise<boolean> {
  const db = getDb();
  const normalizedBatteryId = normalizeBatteryId(batteryId) || batteryId;
  const docRef = db
    .collection("battery_reservations")
    .doc(reservationDocId(imei, normalizedBatteryId));

  try {
    const success = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);

      if (snap.exists) {
        const data = snap.data()!;
        const createdAt = data.createdAt as Timestamp;
        const age = Date.now() - createdAt.toMillis();

        if (age < RESERVATION_TTL_MS) {
          // Active reservation exists, so this battery is already taken.
          return false;
        }
        // Reservation expired — overwrite it
      }

      tx.set(docRef, {
        imei,
        battery_id: normalizedBatteryId,
        phoneNumber,
        createdAt: Timestamp.now(),
      });

      return true;
    });

    return success;
  } catch (error) {
    console.error(
      `Failed to reserve battery ${batteryId} for phone ${phoneNumber}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Release a battery reservation after rental creation or payment failure.
 */
export async function releaseReservation(
  imei: string,
  batteryId: string,
): Promise<void> {
  const db = getDb();
  const docRef = db
    .collection("battery_reservations")
    .doc(reservationDocId(imei, batteryId));

  try {
    await docRef.delete();
  } catch (error) {
    // Non-fatal: reservation will expire via TTL anyway
    console.warn(
      `Failed to release reservation for battery ${batteryId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Get all currently reserved (non-expired) battery IDs for a station.
 * Used by getAvailableBattery to exclude reserved batteries.
 */
export async function getReservedBatteryIds(
  imei: string,
): Promise<Set<string>> {
  const db = getDb();
  const now = Date.now();

  // Single-field query (imei only) — no composite index needed.
  // TTL expiry is checked in-memory. The collection is tiny
  // (at most one doc per battery slot), so this is always fast.
  const snap = await db
    .collection("battery_reservations")
    .where("imei", "==", imei)
    .get();

  const ids = new Set<string>();
  for (const doc of snap.docs) {
    const data = doc.data();
    const createdAt = data.createdAt as Timestamp;
    const age = now - createdAt.toMillis();

    if (age < RESERVATION_TTL_MS && data.battery_id) {
      ids.add(normalizeBatteryId(data.battery_id));
    }
  }
  return ids;
}

/**
 * Acquire a short-lived lock for a phone number so double taps / retries
 * cannot start a second payment flow while the first one is still running.
 */
export async function acquirePhonePaymentLock(
  phoneNumber: string,
): Promise<boolean> {
  const db = getDb();
  const docRef = db
    .collection("phone_payment_locks")
    .doc(phonePaymentLockDocId(phoneNumber));

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);

      if (snap.exists) {
        const data = snap.data()!;
        const createdAt = data.createdAt as Timestamp;
        const age = Date.now() - createdAt.toMillis();

        if (age < PHONE_PAYMENT_LOCK_TTL_MS) {
          return false;
        }
      }

      tx.set(docRef, {
        phoneNumber,
        createdAt: Timestamp.now(),
      });

      return true;
    });
  } catch (error) {
    console.error(
      `Failed to acquire payment lock for phone ${phoneNumber}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Release the short-lived in-flight payment lock for a phone number.
 */
export async function releasePhonePaymentLock(
  phoneNumber: string,
): Promise<void> {
  const db = getDb();
  const docRef = db
    .collection("phone_payment_locks")
    .doc(phonePaymentLockDocId(phoneNumber));

  try {
    await docRef.delete();
  } catch (error) {
    console.warn(
      `Failed to release payment lock for phone ${phoneNumber}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
