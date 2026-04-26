import { CRITICAL_ERROR_TYPES, logError } from "@/lib/server/alerts/log-error";
import { BatteryStateConflictError } from "@/lib/server/payment/battery-state";
import {
  ensureBatteryRentedForTransaction,
  ensureBatteryReturnedForTransaction,
} from "@/lib/server/payment/battery-state";
import {
  createRental,
  getRentalByTransactionId,
  updateRentalUnlockStatus,
} from "@/lib/server/payment/rentals";
import {
  assertRecoveryFence,
  claimTransactionRecovery,
  guardedPatchPaymentTransaction,
  guardedTransitionPaymentTransactionState,
  getPaymentTransaction,
  listTransactionsForReconciliation,
  PAYMENT_TRANSACTIONS_COLLECTION,
  releaseTransactionRecovery,
  type RecoveryFence,
  type PaymentTransactionRecord,
} from "@/lib/server/payment/transactions";
import {
  extractWaafiAudit,
  extractWaafiIds,
  isWaafiCancelled,
  isWaafiCaptured,
  queryWaafiTransactionStatus,
} from "@/lib/server/payment/waafi";
import { triggerUnlockIfNeeded, getProviderDrivenPaymentStatus } from "@/lib/server/payment/status";

const RECOVERY_LEASE_MS = 30_000;
const UNKNOWN_RECONCILE_BASE_DELAY_MS = 15_000;
const UNKNOWN_RECONCILE_MAX_DELAY_MS = 15 * 60_000;
const UNKNOWN_RECONCILE_MAX_ATTEMPTS = 12;
const UNKNOWN_RECONCILE_MANUAL_REVIEW_AGE_MS = 2 * 60 * 60_000;

type ReconcileSummary = {
  scanned: number;
  claimed: number;
  repaired: number;
  failed: number;
  unknownRetained: number;
  errors: Array<{ id: string; reason: string }>;
};

async function ensureRentalForCapturedTransaction(
  transaction: PaymentTransactionRecord,
  fence?: RecoveryFence,
): Promise<"created" | "already_exists"> {
  const providerRef = transaction.providerRef;
  if (!providerRef) {
    throw new Error("Captured transaction is missing providerRef");
  }

  const existing = await getRentalByTransactionId(providerRef);
  if (existing) {
    if (fence) {
      await guardedPatchPaymentTransaction({
        fence,
        patch: {
          rentalCreated: true,
          rentalId: existing.id,
        },
      });
    }

    const delivery = transaction.delivery;
    if (delivery) {
      await ensureBatteryRentedForTransaction({
        batteryId: delivery.batteryId,
        imei: delivery.imei,
        stationCode: delivery.stationCode,
        slotId: delivery.slotId,
        rentalId: existing.id,
        transactionId: providerRef,
        phoneNumber: delivery.canonicalPhoneNumber,
        requestedPhoneNumber: delivery.requestedPhoneNumber,
        phoneAuthority: delivery.phoneAuthority,
        amount: transaction.amount,
        issuerTransactionId: transaction.providerIssuerRef || null,
        referenceId: transaction.providerReferenceId || null,
      });
    }

    await updateRentalUnlockStatus(existing.id, "unlocked");
    return "already_exists";
  }

  try {
    const delivery = transaction.delivery;
    if (!delivery) {
      throw new Error("Captured transaction is missing delivery context");
    }

    const rentalId = await createRental({
      transactionId: providerRef,
      phone: delivery.canonicalPhoneNumber,
      stationId: delivery.stationCode,
      slotId: delivery.slotId,
      batteryId: delivery.batteryId,
      imei: delivery.imei,
      phoneAuthority: delivery.phoneAuthority,
      requestedPhoneNumber: delivery.requestedPhoneNumber,
      amount: transaction.amount,
      issuerTransactionId: transaction.providerIssuerRef || null,
      referenceId: transaction.providerReferenceId || null,
    });

    if (fence) {
      await guardedPatchPaymentTransaction({
        fence,
        patch: {
          rentalCreated: true,
          rentalId,
        },
      });
    }

    await updateRentalUnlockStatus(rentalId, "unlocked");
    return "created";
  } catch (err) {
    if (err instanceof BatteryStateConflictError) {
      return "already_exists";
    }
    throw err;
  }
}

async function reconcileCaptured(
  transaction: PaymentTransactionRecord,
  fence: RecoveryFence,
) {
  if (transaction.status !== "captured") {
    return "noop" as const;
  }
  if (transaction.rentalCreated) {
    return "noop" as const;
  }

  await ensureRentalForCapturedTransaction(transaction, fence);
  return "repaired" as const;
}

function getUnknownReconcileBackoffMs(retryCount: number) {
  const jitter = Math.floor(Math.random() * 1000);
  const exp = Math.min(UNKNOWN_RECONCILE_MAX_DELAY_MS, UNKNOWN_RECONCILE_BASE_DELAY_MS * 2 ** Math.max(0, retryCount));
  return exp + jitter;
}

type TimestampLike = number | Date | { toMillis?: () => number } | { seconds?: number } | null | undefined;

function toMillis(value: TimestampLike): number | null {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object") {
    if (typeof (value as { toMillis?: unknown }).toMillis === "function") {
      return (value as { toMillis: () => number }).toMillis();
    }
    if (typeof (value as { seconds?: unknown }).seconds === "number") {
      return (value as { seconds: number }).seconds * 1000;
    }
  }
  return null;
}

async function scheduleUnknownRetry(
  transaction: PaymentTransactionRecord,
  fence: RecoveryFence,
  reason: string,
) {
  const retryCount = (transaction.unknownRetryCount || 0) + 1;
  const createdAtMs = toMillis(transaction.createdAt) ?? Date.now();
  const ageMs = Date.now() - createdAtMs;
  const needsManualReview =
    retryCount >= UNKNOWN_RECONCILE_MAX_ATTEMPTS ||
    ageMs >= UNKNOWN_RECONCILE_MANUAL_REVIEW_AGE_MS;

  await guardedPatchPaymentTransaction({
    fence,
    patch: {
      unknownRetryCount: retryCount,
      nextReconcileAt: Date.now() + getUnknownReconcileBackoffMs(retryCount),
      manualReviewRequired: needsManualReview,
      manualReviewReason: needsManualReview
        ? `capture_unknown exceeded safe retry window: ${reason}`
        : null,
      failureReason: reason,
      lastReconciledAt: Date.now(),
    },
  });
}

async function reconcileCaptureUnknown(
  transaction: PaymentTransactionRecord,
  fence: RecoveryFence,
) {
  if (transaction.status !== "capture_unknown") {
    return "noop" as const;
  }
  if (transaction.manualReviewRequired) {
    return "unknown_retained" as const;
  }

  if (
    typeof transaction.nextReconcileAt === "number" &&
    transaction.nextReconcileAt > Date.now()
  ) {
    return "unknown_retained" as const;
  }

  let waafiStatus;
  try {
    waafiStatus = await queryWaafiTransactionStatus({
      transactionId: transaction.providerRef || null,
      referenceId: transaction.providerReferenceId || null,
    });
  } catch (error) {
    await logError({
      type: CRITICAL_ERROR_TYPES.RECONCILIATION_FAILED,
      transactionId: transaction.providerRef || transaction.id,
      message: "Waafi status query failed during capture_unknown reconciliation",
      metadata: {
        transactionId: transaction.id,
        providerRef: transaction.providerRef || null,
        retryCount: transaction.unknownRetryCount || 0,
        reason: error instanceof Error ? error.message : String(error),
      },
    });

    await scheduleUnknownRetry(
      transaction,
      fence,
      `Waafi status query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "unknown_retained" as const;
  }

  const waafiAudit = extractWaafiAudit(waafiStatus);
  const waafiIds = extractWaafiIds(waafiStatus);
  const resolvedTransactionId =
    waafiIds.transactionId || transaction.providerRef || null;

  await guardedPatchPaymentTransaction({
    fence,
    patch: {
      waafiAudit: {
        ...(transaction.waafiAudit || {}),
        ...waafiAudit,
      },
      providerRef: resolvedTransactionId,
      providerIssuerRef:
        waafiIds.issuerTransactionId || transaction.providerIssuerRef || null,
      providerReferenceId:
        waafiIds.referenceId || transaction.providerReferenceId || null,
      lastReconciledAt: Date.now(),
    },
  });

  if (isWaafiCaptured(waafiStatus)) {
    await guardedTransitionPaymentTransactionState({
      fence,
      from: "capture_unknown",
      to: "captured",
      patch: {
        capturedAt: transaction.capturedAt || Date.now(),
        rentalCreated: Boolean(transaction.rentalCreated),
        nextReconcileAt: null,
        unknownRetryCount: transaction.unknownRetryCount || 0,
        manualReviewRequired: false,
        manualReviewReason: null,
      },
    });

    const refreshed = await getPaymentTransaction(fence.id);
    if (!refreshed) {
      throw new Error("Transaction disappeared during reconciliation");
    }
    if (!refreshed.rentalCreated) {
      await ensureRentalForCapturedTransaction(refreshed, fence);
    }
    return "repaired" as const;
  }

  if (isWaafiCancelled(waafiStatus)) {
    await guardedTransitionPaymentTransactionState({
      fence,
      from: "capture_unknown",
      to: "failed",
      patch: {
        failedAt: Date.now(),
        failureReason: `Waafi status reconciled as ${String(
          waafiStatus.params?.state || "CANCELLED",
        )}`,
        nextReconcileAt: null,
      },
    });

    const delivery = transaction.delivery;
    if (delivery && resolvedTransactionId) {
      await ensureBatteryReturnedForTransaction({
        batteryId: delivery.batteryId,
        transactionId: resolvedTransactionId,
        note: "Recovered returned state after failed capture reconciliation",
      });
    }

    return "failed" as const;
  }

  await scheduleUnknownRetry(
    transaction,
    fence,
    `Waafi returned unresolved state ${String(waafiStatus.params?.state || "UNKNOWN")}`,
  );
  return "unknown_retained" as const;
}

export async function reconcileTransactions(limit = 50): Promise<ReconcileSummary> {
  const workerId = `reconcile_${process.pid}_${Date.now()}`;
  // Use the broader stale list to catch held and pending_payment cases
  const { listStaleTransactionsForReconciliation } = await import("@/lib/server/payment/transactions");
  const candidates = await listStaleTransactionsForReconciliation(limit);

  const summary: ReconcileSummary = {
    scanned: candidates.length,
    claimed: 0,
    repaired: 0,
    failed: 0,
    unknownRetained: 0,
    errors: [],
  };

  for (const candidate of candidates) {
    const claimed = await claimTransactionRecovery({
      id: candidate.id,
      workerId,
      leaseMs: RECOVERY_LEASE_MS,
    });

    if (!claimed) {
      continue;
    }

    const fence: RecoveryFence = {
      id: candidate.id,
      workerId,
      recoveryVersion: claimed.recoveryVersion,
    };

    summary.claimed += 1;

    try {
      await assertRecoveryFence(fence);
      const current = await getPaymentTransaction(candidate.id);
      if (!current) {
        continue;
      }

      if (current.status === "captured") {
        const result = await reconcileCaptured(current, fence);
        if (result === "repaired") {
          summary.repaired += 1;
        }
      } else if (current.status === "capture_unknown") {
        const result = await reconcileCaptureUnknown(current, fence);
        if (result === "repaired") {
          summary.repaired += 1;
        } else if (result === "failed") {
          summary.failed += 1;
        } else if (result === "unknown_retained") {
          summary.unknownRetained += 1;
        }
      } else if (current.status === "capture_in_progress") {
        // Phase 4: crash-after-commit recovery
        const result = await reconcileCaptureInProgress(current, fence);
        if (result === "repaired") {
          summary.repaired += 1;
        } else if (result === "failed") {
          summary.failed += 1;
        } else if (result === "unknown_retained") {
          summary.unknownRetained += 1;
        }
      } else if (current.status === "verified") {
        // Capture guarantee: ejection verified but capture not yet triggered/completed
        const result = await reconcileVerified(current, fence);
        if (result === "repaired") {
          summary.repaired += 1;
        } else if (result === "failed") {
          summary.failed += 1;
        } else if (result === "unknown_retained") {
          summary.unknownRetained += 1;
        }
      } else if (current.status === "held" || current.status === "pending_payment") {
        // Progression for early-stage transactions
        if (current.status === "held" && !current.unlockStarted) {
           await triggerUnlockIfNeeded(current);
           summary.repaired += 1;
        } else {
           // pending_payment or held-but-started (which might be stuck)
           await getProviderDrivenPaymentStatus(current.id);
           summary.repaired += 1;
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await logError({
        type: CRITICAL_ERROR_TYPES.RECONCILIATION_FAILED,
        transactionId: candidate.id,
        message: "Reconciliation failed for transaction",
        metadata: {
          transactionId: candidate.id,
          status: candidate.status,
          reason: errorMessage,
        },
      });

      summary.errors.push({
        id: candidate.id,
        reason: errorMessage,
      });
    } finally {
      await releaseTransactionRecovery(
        candidate.id,
        workerId,
        claimed.recoveryVersion,
      );
    }
  }

  return summary;
}

/**
 * Phase 4: Reconcile a transaction stuck in capture_in_progress.
 * This happens when the system crashed after calling commitWaafiPreauthorization
 * but before transitioning to captured.
 *
 * Recovery strategy:
 *   1. If captureCompleted is already true → provider confirmed, just mark captured + create rental
 *   2. Otherwise → query provider for actual capture status
 *      a. If provider says captured → mark captured + create rental
 *      b. If provider says cancelled/failed → mark failed
 *      c. If provider says unknown → schedule retry
 */
async function reconcileCaptureInProgress(
  transaction: PaymentTransactionRecord,
  fence: RecoveryFence,
): Promise<"repaired" | "failed" | "unknown_retained" | "noop"> {
  if (transaction.status !== "capture_in_progress") {
    return "noop";
  }

  await logError({
    type: "CAPTURE_RECOVERY_STARTED",
    transactionId: transaction.id,
    message: "Reconciling stale capture_in_progress transaction",
    metadata: {
      captureAttempted: transaction.captureAttempted,
      captureCompleted: transaction.captureCompleted,
      providerCaptureRef: transaction.providerCaptureRef,
      ageMs: Date.now() - (transaction.captureAttemptedAt || 0),
    },
  });

  // Case 1: captureCompleted flag is already set — provider confirmed before crash
  if (transaction.captureCompleted) {
    await guardedTransitionPaymentTransactionState({
      fence,
      from: "capture_in_progress",
      to: "captured",
      patch: {
        capturedAt: transaction.capturedAt || Date.now(),
        rentalCreated: Boolean(transaction.rentalCreated),
      },
    });

    const refreshed = await getPaymentTransaction(fence.id);
    if (refreshed && !refreshed.rentalCreated) {
      await ensureRentalForCapturedTransaction(refreshed, fence);
    }

    await logError({
      type: "CAPTURE_RECOVERED",
      transactionId: transaction.id,
      message: "Recovered capture_in_progress → captured (captureCompleted was already true)",
      metadata: { providerCaptureRef: transaction.providerCaptureRef },
    });
    return "repaired";
  }

  // Case 2: Need to query provider to determine actual state
  let waafiStatus;
  try {
    waafiStatus = await queryWaafiTransactionStatus({
      transactionId: transaction.providerRef || null,
      referenceId: transaction.providerReferenceId || null,
    });
  } catch (error) {
    await logError({
      type: CRITICAL_ERROR_TYPES.RECONCILIATION_FAILED,
      transactionId: transaction.id,
      message: "Waafi status query failed during capture_in_progress reconciliation",
      metadata: {
        reason: error instanceof Error ? error.message : String(error),
      },
    });
    await scheduleUnknownRetry(
      transaction,
      fence,
      `Waafi query failed during capture_in_progress: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "unknown_retained";
  }

  if (isWaafiCaptured(waafiStatus)) {
    // Provider says money was captured — complete the flow
    const captureRef = waafiStatus.params?.transactionId || transaction.providerRef;

    await guardedPatchPaymentTransaction({
      fence,
      patch: {
        captureCompleted: true,
        providerCaptureRef: captureRef,
      },
    });

    await guardedTransitionPaymentTransactionState({
      fence,
      from: "capture_in_progress",
      to: "captured",
      patch: {
        capturedAt: Date.now(),
        rentalCreated: false,
      },
    });

    const refreshed = await getPaymentTransaction(fence.id);
    if (refreshed && !refreshed.rentalCreated) {
      await ensureRentalForCapturedTransaction(refreshed, fence);
    }

    await logError({
      type: "CAPTURE_RECOVERED",
      transactionId: transaction.id,
      message: "Recovered capture_in_progress via provider query — capture confirmed",
      metadata: { providerCaptureRef: captureRef },
    });
    return "repaired";
  }

  if (isWaafiCancelled(waafiStatus)) {
    await guardedTransitionPaymentTransactionState({
      fence,
      from: "capture_in_progress",
      to: "failed",
      patch: {
        failedAt: Date.now(),
        failureReason: `Provider status reconciled as ${String(waafiStatus.params?.state || "CANCELLED")} during capture_in_progress recovery`,
      },
    });

    await logError({
      type: "CAPTURE_RECOVERED",
      transactionId: transaction.id,
      message: "Recovered capture_in_progress — provider says cancelled/failed",
      metadata: { waafiState: waafiStatus.params?.state },
    });
    return "failed";
  }

  // Provider returned ambiguous status — schedule retry
  await scheduleUnknownRetry(
    transaction,
    fence,
    `capture_in_progress: Waafi returned unresolved state ${String(waafiStatus.params?.state || "UNKNOWN")}`,
  );
  return "unknown_retained";
}

/**
 * Phase 4: Reconcile a transaction stuck in verified with captureAttempted=true.
 * This happens when the system crashed between setting captureAttempted and
 * transitioning to capture_in_progress (very narrow window).
 *
 * Recovery: query provider, same logic as capture_in_progress.
 */
async function reconcileVerifiedCrash(
  transaction: PaymentTransactionRecord,
  fence: RecoveryFence,
): Promise<"repaired" | "failed" | "unknown_retained" | "noop"> {
  if (transaction.status !== "verified" || !transaction.captureAttempted) {
    return "noop";
  }

  await logError({
    type: "CAPTURE_RECOVERY_STARTED",
    transactionId: transaction.id,
    message: "Reconciling verified + captureAttempted crash case",
    metadata: {
      captureAttemptedAt: transaction.captureAttemptedAt,
      providerRef: transaction.providerRef,
    },
  });

  // Query provider for actual capture status
  let waafiStatus;
  try {
    waafiStatus = await queryWaafiTransactionStatus({
      transactionId: transaction.providerRef || null,
      referenceId: transaction.providerReferenceId || null,
    });
  } catch (error) {
    await logError({
      type: CRITICAL_ERROR_TYPES.RECONCILIATION_FAILED,
      transactionId: transaction.id,
      message: "Waafi status query failed during verified+captureAttempted reconciliation",
      metadata: {
        reason: error instanceof Error ? error.message : String(error),
      },
    });
    return "unknown_retained";
  }

  if (isWaafiCaptured(waafiStatus)) {
    const captureRef = waafiStatus.params?.transactionId || transaction.providerRef;

    await guardedPatchPaymentTransaction({
      fence,
      patch: {
        captureCompleted: true,
        providerCaptureRef: captureRef,
      },
    });

    await guardedTransitionPaymentTransactionState({
      fence,
      from: "verified",
      to: "captured",
      patch: {
        capturedAt: Date.now(),
        rentalCreated: false,
      },
    });

    const refreshed = await getPaymentTransaction(fence.id);
    if (refreshed && !refreshed.rentalCreated) {
      await ensureRentalForCapturedTransaction(refreshed, fence);
    }

    await logError({
      type: "CAPTURE_RECOVERED",
      transactionId: transaction.id,
      message: "Recovered verified+captureAttempted crash — provider confirmed capture",
      metadata: { providerCaptureRef: captureRef },
    });
    return "repaired";
  }

  if (isWaafiCancelled(waafiStatus)) {
    await guardedTransitionPaymentTransactionState({
      fence,
      from: "verified",
      to: "failed",
      patch: {
        failedAt: Date.now(),
        failureReason: `Provider status reconciled as ${String(waafiStatus.params?.state || "CANCELLED")} during verified+captureAttempted recovery`,
      },
    });
    return "failed";
  }

  // Ambiguous — but since we're in verified (not capture_in_progress),
  // the commit call may not have reached the provider yet. Safe to retry later.
  return "unknown_retained";
}

/**
 * Reconciles a transaction in verified status (ejection confirmed).
 * Ensures it progresses to capture.
 */
async function reconcileVerified(
  transaction: PaymentTransactionRecord,
  fence: RecoveryFence,
): Promise<"repaired" | "failed" | "unknown_retained" | "noop"> {
  if (transaction.status !== "verified") {
    return "noop";
  }

  // If captureAttempted is true, we use the specific crash recovery logic
  if (transaction.captureAttempted) {
    return reconcileVerifiedCrash(transaction, fence);
  }

  await logTransactionEvent(transaction.id, "AUTO_TRIGGER_CAPTURE_RECOVERY", {
    reason: "Transaction stuck in verified state without capture attempt",
  }, "IMPORTANT");

  try {
    const { finalizeCapture } = await import("@/lib/server/payment/process-payment");
    await finalizeCapture(transaction.id);
    return "repaired";
  } catch (error) {
    await logError({
      type: CRITICAL_ERROR_TYPES.RECONCILIATION_FAILED,
      transactionId: transaction.id,
      message: "Failed to trigger capture recovery for verified transaction",
      metadata: { error: String(error) },
    });
    return "unknown_retained";
  }
}

export async function repairTransactionIfNeeded(id: string) {
  const workerId = `reconcile_one_${process.pid}_${Date.now()}`;
  const claimed = await claimTransactionRecovery({
    id,
    workerId,
    leaseMs: RECOVERY_LEASE_MS,
  });

  if (!claimed) {
    return { status: "busy_or_missing" as const };
  }

  const fence: RecoveryFence = {
    id,
    workerId,
    recoveryVersion: claimed.recoveryVersion,
  };

  try {
    await assertRecoveryFence(fence);
    const current = await getPaymentTransaction(id);
    if (!current) {
      return { status: "missing" as const };
    }

    if (current.status === "captured") {
      if (!current.rentalCreated) {
        await ensureRentalForCapturedTransaction(current, fence);
        return { status: "repaired" as const };
      }
      return { status: "noop" as const };
    }

    if (current.status === "capture_unknown") {
      const result = await reconcileCaptureUnknown(current, fence);
      return { status: result };
    }

    // Phase 4: capture_in_progress crash recovery
    if (current.status === "capture_in_progress") {
      const result = await reconcileCaptureInProgress(current, fence);
      return { status: result };
    }

    // Phase 4: verified + captureAttempted crash recovery
    if (current.status === "verified" && current.captureAttempted) {
      const result = await reconcileVerifiedCrash(current, fence);
      return { status: result };
    }

    if (current.status === "failed") {
      if (current.delivery && current.providerRef) {
        await ensureBatteryReturnedForTransaction({
          batteryId: current.delivery.batteryId,
          transactionId: current.providerRef,
          note: "Recovered returned state for failed transaction",
        });
      }
      return { status: "noop" as const };
    }

    return { status: "noop" as const };
  } finally {
    await releaseTransactionRecovery(id, workerId, claimed.recoveryVersion);
  }
}

export const reconcileTransactionById = repairTransactionIfNeeded;

/**
 * Phase 4 Hardening: Invariant audit.
 *
 * Scans the database for transactions that violate system invariants.
 * Designed to run on a periodic cron (hourly/daily).
 *
 * Detected violations:
 *   1. captured without rentalCreated (data integrity gap)
 *   2. capture_in_progress older than 5 minutes (stuck)
 *   3. verified + captureAttempted but not progressed (crash orphan)
 *   4. captured + captureCompleted=false (impossible state)
 *
 * Does NOT auto-repair — only logs for alerting and manual review.
 */
export async function auditCaptureInvariants(limit = 100): Promise<{
  scanned: number;
  violations: Array<{ id: string; type: string; details: Record<string, unknown> }>;
}> {
  const db = (await import("@/lib/server/firebase-admin")).getDb();
  const col = PAYMENT_TRANSACTIONS_COLLECTION;

  const violations: Array<{ id: string; type: string; details: Record<string, unknown> }> = [];
  let scanned = 0;

  // ── Check 1: captured without rental ──────────────────────────────
  const capturedSnap = await db
    .collection(col)
    .where("status", "==", "captured")
    .limit(limit)
    .get();

  for (const doc of capturedSnap.docs) {
    scanned++;
    const tx = doc.data() as PaymentTransactionRecord;

    if (!tx.rentalCreated) {
      violations.push({
        id: doc.id,
        type: "CAPTURED_WITHOUT_RENTAL",
        details: {
          capturedAt: tx.capturedAt,
          rentalCreated: tx.rentalCreated,
          station: tx.station,
          phone: tx.phone,
        },
      });
    }

    // Impossible state: captured but captureCompleted is false
    if (tx.captureCompleted === false) {
      violations.push({
        id: doc.id,
        type: "CAPTURED_BUT_CAPTURE_NOT_COMPLETED",
        details: {
          capturedAt: tx.capturedAt,
          captureCompleted: tx.captureCompleted,
          providerCaptureRef: tx.providerCaptureRef,
        },
      });
    }
  }

  // ── Check 2: stale capture_in_progress ────────────────────────────
  const STALE_CAPTURE_THRESHOLD_MS = 5 * 60_000; // 5 minutes
  const captureInProgressSnap = await db
    .collection(col)
    .where("status", "==", "capture_in_progress")
    .limit(limit)
    .get();

  for (const doc of captureInProgressSnap.docs) {
    scanned++;
    const tx = doc.data() as PaymentTransactionRecord;
    const ageMs = Date.now() - (tx.captureAttemptedAt || 0);

    if (ageMs > STALE_CAPTURE_THRESHOLD_MS) {
      violations.push({
        id: doc.id,
        type: "STALE_CAPTURE_IN_PROGRESS",
        details: {
          captureAttemptedAt: tx.captureAttemptedAt,
          ageMs,
          captureCompleted: tx.captureCompleted,
          captureRetryCount: tx.captureRetryCount,
          station: tx.station,
        },
      });
    }
  }

  // ── Check 3: verified + captureAttempted orphans ──────────────────
  const verifiedSnap = await db
    .collection(col)
    .where("status", "==", "verified")
    .where("captureAttempted", "==", true)
    .limit(limit)
    .get();

  for (const doc of verifiedSnap.docs) {
    scanned++;
    const tx = doc.data() as PaymentTransactionRecord;

    violations.push({
      id: doc.id,
      type: "VERIFIED_WITH_CAPTURE_ATTEMPTED",
      details: {
        captureAttemptedAt: tx.captureAttemptedAt,
        captureCompleted: tx.captureCompleted,
        station: tx.station,
      },
    });
  }

  // ── Check 4: SLA Breach ───────────────────────────────────────────
  const activeStatuses = ["initiated", "held", "confirm_required", "resolving", "verified", "capture_in_progress", "pending_payment"];
  const activeSnap = await db
    .collection(col)
    .where("status", "in", activeStatuses)
    .limit(limit)
    .get();

  for (const doc of activeSnap.docs) {
    const tx = doc.data() as PaymentTransactionRecord;
    let createdAtMs = 0;
    if (typeof tx.createdAt === "number") {
      createdAtMs = tx.createdAt;
    } else if (tx.createdAt instanceof Date) {
      createdAtMs = tx.createdAt.getTime();
    } else if (tx.createdAt && typeof (tx.createdAt as any).toMillis === "function") {
      createdAtMs = (tx.createdAt as any).toMillis();
    }

    if (createdAtMs > 0 && Date.now() - createdAtMs > 60000) {
      scanned++;
      violations.push({
        id: doc.id,
        type: "SLA_BREACH_DETECTED",
        details: {
          createdAt: tx.createdAt,
          ageMs: Date.now() - createdAtMs,
          status: tx.status,
          station: tx.station,
        },
      });
    }
  }

  // ── Log all violations ────────────────────────────────────────────
  for (const violation of violations) {
    const errorType = violation.type === "SLA_BREACH_DETECTED" 
      ? CRITICAL_ERROR_TYPES.SLA_BREACH_DETECTED 
      : CRITICAL_ERROR_TYPES.CAPTURE_INCONSISTENCY;

    await logError({
      type: errorType,
      transactionId: violation.id,
      message: `Invariant violation: ${violation.type}`,
      metadata: violation.details,
    });
  }

  if (violations.length > 0) {
    await logError({
      type: "CAPTURE_AUDIT_SUMMARY",
      message: `Capture invariant audit complete: ${violations.length} violation(s) found in ${scanned} transactions`,
      metadata: {
        scanned,
        violationCount: violations.length,
        types: [...new Set(violations.map(v => v.type))],
      },
    });
  }

  return { scanned, violations };
}
