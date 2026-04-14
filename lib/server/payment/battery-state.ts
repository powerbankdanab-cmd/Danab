import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { getDb } from "@/lib/server/firebase-admin";
import { normalizeBatteryId } from "@/lib/server/payment/battery-id";

export const BATTERY_STATE_COLLECTION = "battery_state";

function batteryStateDocId(batteryId: string) {
  return normalizeBatteryId(batteryId) || batteryId;
}

export class BatteryStateConflictError extends Error {
  batteryId: string;
  activeRentalId: string | null;

  constructor(batteryId: string, activeRentalId: string | null) {
    super(`Battery ${batteryId} already has active rental ${activeRentalId || "unknown"}`);
    this.name = "BatteryStateConflictError";
    this.batteryId = batteryId;
    this.activeRentalId = activeRentalId;
  }
}

export async function getClaimedBatteryIds(
  batteryIds: string[],
): Promise<Set<string>> {
  const uniqueBatteryIds = Array.from(
    new Set(batteryIds.map(batteryStateDocId).filter(Boolean)),
  );

  if (uniqueBatteryIds.length === 0) {
    return new Set<string>();
  }

  const docs = await Promise.all(
    uniqueBatteryIds.map((batteryId) =>
      getDb().collection(BATTERY_STATE_COLLECTION).doc(batteryId).get(),
    ),
  );

  const claimedIds = new Set<string>();
  for (const doc of docs) {
    if (!doc.exists) continue;

    const data = doc.data() || {};
    if (
      String(data.status || "").toLowerCase() === "rented" &&
      String(data.activeRentalId || "").trim().length > 0
    ) {
      claimedIds.add(batteryStateDocId(String(data.battery_id || doc.id)));
    }
  }

  return claimedIds;
}

export async function clearBatteryStateForRental({
  batteryId,
  rentalId,
  note,
}: {
  batteryId: string;
  rentalId: string;
  note?: string;
}) {
  const db = getDb();
  const normalizedBatteryId = batteryStateDocId(batteryId);
  const stateRef = db
    .collection(BATTERY_STATE_COLLECTION)
    .doc(normalizedBatteryId);
  const now = Timestamp.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);

    if (!snap.exists) {
      tx.set(
        stateRef,
        {
          battery_id: normalizedBatteryId,
          status: "returned",
          updatedAt: now,
          lastReturnedAt: now,
          lastReturnedRentalId: rentalId,
          ...(note ? { note } : {}),
        },
        { merge: true },
      );
      return;
    }

    const data = snap.data() || {};
    const activeRentalId = String(data.activeRentalId || "");

    if (activeRentalId && activeRentalId !== rentalId) {
      return;
    }

    tx.set(
      stateRef,
      {
        battery_id: normalizedBatteryId,
        status: "returned",
        updatedAt: now,
        lastReturnedAt: now,
        lastReturnedRentalId: rentalId,
        ...(note ? { note } : {}),
        activeRentalId: FieldValue.delete(),
        imei: FieldValue.delete(),
        stationCode: FieldValue.delete(),
        slot_id: FieldValue.delete(),
        phoneNumber: FieldValue.delete(),
        requestedPhoneNumber: FieldValue.delete(),
        phoneAuthority: FieldValue.delete(),
        transactionId: FieldValue.delete(),
        issuerTransactionId: FieldValue.delete(),
        referenceId: FieldValue.delete(),
        amount: FieldValue.delete(),
        claimedAt: FieldValue.delete(),
        waafiAccountNo: FieldValue.delete(),
        waafiConfirmedPhoneNumber: FieldValue.delete(),
      },
      { merge: true },
    );
  });
}
