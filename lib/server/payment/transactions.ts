import { Timestamp } from "firebase-admin/firestore";

import { getDb } from "@/lib/server/firebase-admin";
import { HttpError } from "@/lib/server/payment/errors";

export const PAYMENT_TRANSACTIONS_COLLECTION = "transactions";

export type PaymentTransactionStatus =
  | "initiated"
  | "held"
  | "verified"
  | "captured"
  | "failed"
  | "confirm_required"
  | "capture_unknown";

export type PaymentDeliveryContext = {
  imei: string;
  stationCode: string;
  batteryId: string;
  slotId: string;
  phoneAuthority: string;
  unlockAttempts: number;
  requestedPhoneNumber: string;
  canonicalPhoneNumber: string;
};

export type PaymentTransactionRecord = {
  id: string;
  status: PaymentTransactionStatus;
  phone: string;
  station: string;
  amount: number;
  providerRef: string | null;
  createdAt: number;
  updatedAt: number;
  heldAt?: number;
  verifiedAt?: number;
  capturedAt?: number;
  failedAt?: number;
  failureReason?: string;
  captureUnknownAt?: number;
  providerIssuerRef?: string | null;
  providerReferenceId?: string | null;
  rentalCreated?: boolean;
  rentalId?: string | null;
  delivery?: PaymentDeliveryContext;
  waafiAudit?: Record<string, unknown>;
  recoveryAttempts?: number;
  recoveryLeaseUntil?: number | null;
  recoveryWorkerId?: string | null;
  recoveryVersion?: number;
  unknownRetryCount?: number;
  nextReconcileAt?: number | null;
  manualReviewRequired?: boolean;
  manualReviewReason?: string | null;
};

type JsonObject = Record<string, unknown>;

export async function createOrGetPaymentTransaction(input: {
  id: string;
  phone: string;
  station: string;
  amount: number;
}) {
  const db = getDb();
  const docRef = db.collection(PAYMENT_TRANSACTIONS_COLLECTION).doc(input.id);
  const now = Date.now();
  const nowTs = Timestamp.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (snap.exists) {
      const existing = snap.data() as PaymentTransactionRecord;
      return { created: false, record: existing };
    }

    const record: PaymentTransactionRecord = {
      id: input.id,
      status: "initiated",
      phone: input.phone,
      station: input.station,
      amount: input.amount,
      providerRef: null,
      rentalCreated: false,
      createdAt: now,
      updatedAt: now,
    };

    tx.set(docRef, {
      ...record,
      createdAtTs: nowTs,
      updatedAtTs: nowTs,
    });

    return { created: true, record };
  });
}

export async function getPaymentTransaction(
  id: string,
): Promise<PaymentTransactionRecord | null> {
  const snap = await getDb()
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .doc(id)
    .get();
  if (!snap.exists) {
    return null;
  }
  return snap.data() as PaymentTransactionRecord;
}

export async function ensurePaymentTransactionState(
  id: string,
  expected: PaymentTransactionStatus,
) {
  const record = await getPaymentTransaction(id);
  if (!record) {
    throw new HttpError(404, "Transaction record not found", {
      transactionId: id,
    });
  }

  if (record.status !== expected) {
    throw new HttpError(409, "invalid state", {
      transactionId: id,
      expectedState: expected,
      actualState: record.status,
    });
  }

  return record;
}

export async function transitionPaymentTransactionState(input: {
  id: string;
  from: PaymentTransactionStatus;
  to: PaymentTransactionStatus;
  patch?: JsonObject;
}) {
  const db = getDb();
  const docRef = db.collection(PAYMENT_TRANSACTIONS_COLLECTION).doc(input.id);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new HttpError(404, "Transaction record not found", {
        transactionId: input.id,
      });
    }

    const current = snap.data() as PaymentTransactionRecord;
    if (current.status !== input.from) {
      throw new HttpError(409, "invalid state", {
        transactionId: input.id,
        expectedState: input.from,
        actualState: current.status,
      });
    }

    const now = Date.now();
    const nextDoc: JsonObject = {
      status: input.to,
      updatedAt: now,
      updatedAtTs: Timestamp.now(),
      ...(input.patch || {}),
    };

    tx.update(docRef, nextDoc);
    return {
      ...(current as JsonObject),
      ...(nextDoc as JsonObject),
    } as PaymentTransactionRecord;
  });
}

export async function patchPaymentTransaction(input: {
  id: string;
  patch: JsonObject;
}) {
  await getDb()
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .doc(input.id)
    .set(
      {
        ...input.patch,
        updatedAt: Date.now(),
        updatedAtTs: Timestamp.now(),
      },
      { merge: true },
    );
}

export type RecoveryFence = {
  id: string;
  workerId: string;
  recoveryVersion: number;
};

export async function listTransactionsForReconciliation(limit = 50) {
  const db = getDb();
  const [capturedSnap, unknownSnap] = await Promise.all([
    db
      .collection(PAYMENT_TRANSACTIONS_COLLECTION)
      .where("status", "==", "captured")
      .limit(limit)
      .get(),
    db
      .collection(PAYMENT_TRANSACTIONS_COLLECTION)
      .where("status", "==", "capture_unknown")
      .limit(limit)
      .get(),
  ]);

  const byId = new Map<string, PaymentTransactionRecord>();

  for (const doc of capturedSnap.docs) {
    const tx = doc.data() as PaymentTransactionRecord;
    if (!tx.rentalCreated) {
      byId.set(doc.id, tx);
    }
  }

  for (const doc of unknownSnap.docs) {
    byId.set(doc.id, doc.data() as PaymentTransactionRecord);
  }

  return Array.from(byId.values());
}

export async function listStaleTransactionsForReconciliation(limit = 20) {
  const db = getDb();
  const now = Date.now();
  const sixtySecondsAgo = now - 60000;

  // Query 1: confirm_required that are older than 60s
  const confirmSnap = await db
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .where("status", "==", "confirm_required")
    .where("updatedAt", "<", sixtySecondsAgo)
    .limit(limit)
    .get();

  // Query 2: captured that are missing rentals
  // Firestore doesn't support != for boolean efficiently with limit combined with other filters here,
  // so we'll filter in JS or just get more.
  const capturedSnap = await db
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .where("status", "==", "captured")
    .limit(limit * 2) // Get a bit more to account for those already linked
    .get();

  const results: PaymentTransactionRecord[] = [];
  
  // Add confirm_required
  for (const doc of confirmSnap.docs) {
    results.push(doc.data() as PaymentTransactionRecord);
  }

  // Add captured without rental (only up to limit)
  for (const doc of capturedSnap.docs) {
    if (results.length >= limit) break;
    const tx = doc.data() as PaymentTransactionRecord;
    if (!tx.rentalCreated) {
      results.push(tx);
    }
  }

  return results;
}

export async function claimTransactionRecovery(input: {
  id: string;
  workerId: string;
  leaseMs: number;
}) {
  const db = getDb();
  const docRef = db.collection(PAYMENT_TRANSACTIONS_COLLECTION).doc(input.id);
  const now = Date.now();
  const leaseUntil = now + input.leaseMs;

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      return null;
    }

    const current = snap.data() as PaymentTransactionRecord;
    const activeLease =
      typeof current.recoveryLeaseUntil === "number" &&
      current.recoveryLeaseUntil > now &&
      current.recoveryWorkerId &&
      current.recoveryWorkerId !== input.workerId;

    if (activeLease) {
      return null;
    }

    const nextRecoveryVersion = (current.recoveryVersion || 0) + 1;

    tx.update(docRef, {
      recoveryWorkerId: input.workerId,
      recoveryLeaseUntil: leaseUntil,
      recoveryAttempts: (current.recoveryAttempts || 0) + 1,
      recoveryVersion: nextRecoveryVersion,
      updatedAt: now,
      updatedAtTs: Timestamp.now(),
    });

    return {
      record: current,
      recoveryVersion: nextRecoveryVersion,
    };
  });
}

export async function releaseTransactionRecovery(
  id: string,
  workerId: string,
  recoveryVersion?: number,
) {
  const db = getDb();
  const docRef = db.collection(PAYMENT_TRANSACTIONS_COLLECTION).doc(id);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      return;
    }

    const current = snap.data() as PaymentTransactionRecord;
    if (current.recoveryWorkerId !== workerId) {
      return;
    }
    if (
      typeof recoveryVersion === "number" &&
      (current.recoveryVersion || 0) !== recoveryVersion
    ) {
      return;
    }

    tx.update(docRef, {
      recoveryLeaseUntil: null,
      recoveryWorkerId: null,
      updatedAt: Date.now(),
      updatedAtTs: Timestamp.now(),
    });
  });
}

export async function assertRecoveryFence(fence: RecoveryFence) {
  const tx = await getPaymentTransaction(fence.id);
  if (!tx) {
    throw new Error("Transaction missing during fenced operation");
  }

  if (tx.recoveryWorkerId !== fence.workerId) {
    throw new Error("Recovery fence rejected: worker mismatch");
  }

  if ((tx.recoveryVersion || 0) !== fence.recoveryVersion) {
    throw new Error("Recovery fence rejected: stale version");
  }

  if (
    typeof tx.recoveryLeaseUntil === "number" &&
    tx.recoveryLeaseUntil < Date.now()
  ) {
    throw new Error("Recovery fence rejected: lease expired");
  }

  return tx;
}

export async function guardedPatchPaymentTransaction(input: {
  fence: RecoveryFence;
  patch: JsonObject;
}) {
  const db = getDb();
  const docRef = db.collection(PAYMENT_TRANSACTIONS_COLLECTION).doc(input.fence.id);
  const now = Date.now();

  await db.runTransaction(async (txn) => {
    const snap = await txn.get(docRef);
    if (!snap.exists) {
      throw new Error("Transaction missing during guarded patch");
    }

    const current = snap.data() as PaymentTransactionRecord;
    if (
      current.recoveryWorkerId !== input.fence.workerId ||
      (current.recoveryVersion || 0) !== input.fence.recoveryVersion
    ) {
      throw new Error("Recovery fence rejected: stale guarded patch");
    }

    txn.set(
      docRef,
      {
        ...input.patch,
        updatedAt: now,
        updatedAtTs: Timestamp.now(),
      },
      { merge: true },
    );
  });
}

export async function guardedTransitionPaymentTransactionState(input: {
  fence: RecoveryFence;
  from: PaymentTransactionStatus;
  to: PaymentTransactionStatus;
  patch?: JsonObject;
}) {
  const db = getDb();
  const docRef = db.collection(PAYMENT_TRANSACTIONS_COLLECTION).doc(input.fence.id);

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(docRef);
    if (!snap.exists) {
      throw new Error("Transaction missing during guarded transition");
    }

    const current = snap.data() as PaymentTransactionRecord;
    if (
      current.recoveryWorkerId !== input.fence.workerId ||
      (current.recoveryVersion || 0) !== input.fence.recoveryVersion
    ) {
      throw new Error("Recovery fence rejected: stale guarded transition");
    }

    if (current.status !== input.from) {
      throw new HttpError(409, "invalid state", {
        transactionId: input.fence.id,
        expectedState: input.from,
        actualState: current.status,
      });
    }

    const now = Date.now();
    const nextDoc: JsonObject = {
      status: input.to,
      updatedAt: now,
      updatedAtTs: Timestamp.now(),
      ...(input.patch || {}),
    };

    txn.update(docRef, nextDoc);
    return {
      ...(current as JsonObject),
      ...(nextDoc as JsonObject),
    } as PaymentTransactionRecord;
  });
}
