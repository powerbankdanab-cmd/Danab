import { Timestamp } from "firebase-admin/firestore";

import { getDb } from "@/lib/server/firebase-admin";
import { HttpError } from "@/lib/server/payment/errors";

export const PAYMENT_TRANSACTIONS_COLLECTION = "transactions";

export type MinimalTransactionRecord = {
  phone: string;
  amount: number;
  status: "pending_payment";
  providerRef?: string | null;
  failureReason?: string | null;
  unlockStarted?: boolean;
  createdAt: Date | Timestamp | number;
  updatedAt: Date | Timestamp | number;
};

export type PaymentTransactionStatus =
  | "initiated"
  | "held"
  | "pending_payment"
  | "paid"
  | "processing"
  | "verifying"
  | "verified"
  | "capture_in_progress"
  | "captured"
  | "failed"
  | "confirm_required"
  | "capture_unknown"
  | "resolving";

export type PaymentDeliveryContext = {
  imei: string;
  stationCode: string;
  batteryId: string;
  slotId: string;
  phoneAuthority: string;
  unlockAttempts: number;
  requestedPhoneNumber: string;
  canonicalPhoneNumber: string;
  unlockStartedAt?: number;
};

export type PaymentTransactionRecord = {
  id: string;
  status: PaymentTransactionStatus;
  phone: string;
  station: string;
  amount: number;
  providerRef: string | null;
  unlockStarted?: boolean;
  processingStartedAt?: Date | Timestamp | number;
  createdAt: Date | Timestamp | number;
  updatedAt: Date | Timestamp | number;
  heldAt?: number;
  verifiedAt?: number;
  capturedAt?: number;
  failedAt?: number;
  failureReason?: string;
  captureUnknownAt?: number;
  confirmRequiredAt?: number;
  lastConfirmVerificationAt?: number;
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
  // Phase 4: Capture tracking for idempotent, crash-safe finalization
  captureAttempted?: boolean;
  captureCompleted?: boolean;
  captureAttemptedAt?: number;
  providerCaptureRef?: string | null;
  captureRetryCount?: number;
  missingProviderRef?: boolean;
  // Observability summary fields
  finalStep?: string | null;
  processingTimeMs?: number | null;
  eventCount?: number;
};

export type EventLevel = "DEBUG" | "INFO" | "IMPORTANT" | "CRITICAL";

export interface TransactionEvent {
  transactionId: string;
  event: string;
  level: EventLevel;
  sequence: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  expiresAt: number; // For retention cleanup
}

type JsonObject = Record<string, unknown>;

export async function createMinimalTransaction(input: {
  phone: string;
  amount: number;
}) {
  const now = Date.now();
  const record: MinimalTransactionRecord = {
    phone: input.phone,
    amount: input.amount,
    status: "pending_payment",
    unlockStarted: false,
    createdAt: now,
    updatedAt: now,
  };

  const docRef = await getDb()
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .add(record);

  return {
    id: docRef.id,
    record,
  };
}

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
      unlockStarted: false,
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
  return { id, ...(snap.data() as Omit<PaymentTransactionRecord, "id">) };
}

export async function patchPhase2Transaction(input: {
  id: string;
  patch: JsonObject;
}) {
  await getDb()
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .doc(input.id)
    .set(
      {
        ...input.patch,
        updatedAt: Timestamp.now(),
      },
      { merge: true },
    );
}

export async function completePhase2Transaction(input: {
  id: string;
  status: "paid" | "failed";
  failureReason?: string;
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

    const current = snap.data() as { status?: string };
    if (current.status === "paid" || current.status === "failed") {
      return current.status as "paid" | "failed";
    }

    if (current.status !== "pending_payment") {
      throw new HttpError(409, "invalid state", {
        transactionId: input.id,
        expectedState: "pending_payment",
        actualState: current.status,
      });
    }

    tx.update(docRef, {
      status: input.status,
      updatedAt: Timestamp.now(),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    });

    return input.status;
  });
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
  const [capturedSnap, unknownSnap, inProgressSnap, verifiedSnap] = await Promise.all([
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
    db
      .collection(PAYMENT_TRANSACTIONS_COLLECTION)
      .where("status", "==", "capture_in_progress")
      .limit(limit)
      .get(),
    db
      .collection(PAYMENT_TRANSACTIONS_COLLECTION)
      .where("status", "==", "verified")
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

  for (const doc of inProgressSnap.docs) {
    byId.set(doc.id, doc.data() as PaymentTransactionRecord);
  }

  for (const doc of verifiedSnap.docs) {
    const tx = doc.data() as PaymentTransactionRecord;
    if (tx.captureAttempted) {
      byId.set(doc.id, tx);
    }
  }

  return Array.from(byId.values());
}

export async function listStaleTransactionsForReconciliation(limit = 20) {
  const db = getDb();
  const now = Date.now();
  const confirmationCutoff = now - 120_000;
  // Phase 4: capture_in_progress older than 60s is likely a crash-after-commit
  const captureInProgressCutoff = now - 60_000;

  // Query 1: confirm_required transactions older than 2 minutes
  const confirmSnap = await db
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .where("status", "==", "confirm_required")
    .where("confirmRequiredAt", "<", confirmationCutoff)
    .orderBy("confirmRequiredAt")
    .limit(limit)
    .get();

  // Query 2: captured that are missing rentals
  const capturedSnap = await db
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .where("status", "==", "captured")
    .orderBy("updatedAt")
    .limit(limit * 2)
    .get();

  // Query 3: pending_payment transactions
  const pendingSnap = await db
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .where("status", "==", "pending_payment")
    .orderBy("updatedAt")
    .limit(limit)
    .get();

  // Query 4 (Phase 4): capture_in_progress stuck for >60s (crash recovery)
  const captureInProgressSnap = await db
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .where("status", "==", "capture_in_progress")
    .where("captureAttemptedAt", "<", captureInProgressCutoff)
    .orderBy("captureAttemptedAt")
    .limit(limit)
    .get();

  // Query 5 (Phase 4): verified with captureAttempted=true (crash between commit and state write)
  const verifiedCrashSnap = await db
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .where("status", "==", "verified")
    .where("captureAttempted", "==", true)
    .limit(limit)
    .get();

  const results: PaymentTransactionRecord[] = [];

  // Add confirm_required
  for (const doc of confirmSnap.docs) {
    results.push(doc.data() as PaymentTransactionRecord);
  }

  // Add pending_payment
  for (const doc of pendingSnap.docs) {
    if (results.length >= limit) break;
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

  // Phase 4: Add stale capture_in_progress
  for (const doc of captureInProgressSnap.docs) {
    if (results.length >= limit) break;
    results.push(doc.data() as PaymentTransactionRecord);
  }

  // Phase 4: Add verified + captureAttempted crash cases
  for (const doc of verifiedCrashSnap.docs) {
    if (results.length >= limit) break;
    results.push(doc.data() as PaymentTransactionRecord);
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
/**
 * Logs a transaction event with production-grade controls (levels, sequence, deduplication).
 */
export async function logTransactionEvent(
  transactionId: string,
  event: string,
  metadata?: Record<string, unknown>,
  level: EventLevel = "INFO",
) {
  // Level 1: Filter out noise (DEBUG events are console-only)
  if (level === "DEBUG") {
    console.debug(`[DEBUG][${transactionId}] ${event}`, metadata || "");
    return;
  }

  try {
    const db = getDb();
    const eventCol = db.collection("transaction_events");
    const txRef = db.collection(PAYMENT_TRANSACTIONS_COLLECTION).doc(transactionId);

    await db.runTransaction(async (tx) => {
      // 1. Get current sequence and deduplication context
      const snap = await tx.get(txRef);
      if (!snap.exists) return;

      const data = snap.data() as PaymentTransactionRecord;
      const sequence = (data.eventCount || 0) + 1;

      // 2. Simple Deduplication for IMPORTANT/CRITICAL events
      // (Optional: prevent rapid fire of same event)
      // This is a business logic decision. For now, we'll just log.

      // 3. Create Event Document
      const eventDocRef = eventCol.doc();
      const expiresAt = level === "CRITICAL" || level === "IMPORTANT"
        ? Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days
        : Date.now() + 7 * 24 * 60 * 60 * 1000;  // 7 days

      const eventDoc: TransactionEvent = {
        transactionId,
        event,
        level,
        sequence,
        metadata: metadata || {},
        createdAt: Date.now(),
        expiresAt,
      };

      tx.set(eventDocRef, eventDoc);

      // 4. Update Transaction Summary
      tx.update(txRef, {
        eventCount: sequence,
        updatedAt: Date.now(),
        updatedAtTs: Timestamp.now(),
        // If it's a terminal event, update finalStep
        ...(event.endsWith("_SUCCESS") || event.endsWith("_FAILED") || event === "TIMEOUT"
          ? {
              finalStep: event,
              processingTimeMs: Date.now() - (
                typeof data.createdAt === "number" ? data.createdAt : 
                (data.createdAt as any)?.toMillis ? (data.createdAt as any).toMillis() : 
                (data.createdAt as any)?.seconds ? (data.createdAt as any).seconds * 1000 :
                Date.now()
              ),
            }
          : {}),
      });
    });
  } catch (error) {
    console.error(`[LOG_EVENT_FAILED] Tx: ${transactionId}, Event: ${event}:`, error);
  }
}
