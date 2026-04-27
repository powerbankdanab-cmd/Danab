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
  logTransactionEvent,
  toMillis,
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
const HELD_STALL_SLA_MS = 45_000; // 45s SLA for hardware flow
const HELD_RESUME_COOLDOWN_MS = 20_000; // 20s between resume attempts
const UNKNOWN_RECONCILE_BASE_DELAY_MS = 30_000; // Start at 30s
const UNKNOWN_RECONCILE_MAX_DELAY_MS = 30 * 60_000; // Max 30 min
const UNKNOWN_RECONCILE_MAX_ATTEMPTS = 15;
const UNKNOWN_RECONCILE_MANUAL_REVIEW_AGE_MS = 2 * 60 * 60_000;

function calculateNextReconcileDelay(attempt: number): number {
  // Exponential backoff: 30s, 60s, 120s, 240s...
  const base = UNKNOWN_RECONCILE_BASE_DELAY_MS * Math.pow(2, attempt);
  const capped = Math.min(base, UNKNOWN_RECONCILE_MAX_DELAY_MS);
  
  // Add 10-20% jitter to prevent "thundering herd"
  const jitter = 0.8 + Math.random() * 0.4; // 80% to 120%
  return Math.floor(capped * jitter);
}

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
    // Even if rental created, check provider truth for symmetric repair
    return reconcileCapturedSymmetric(transaction, fence);
  }

  await ensureRentalForCapturedTransaction(transaction, fence);
  return "repaired" as const;
}

/**
 * Phase 7: Symmetric Repair. 
 * If we think it's captured but provider says it's cancelled, we must repair toward provider.
 */
async function reconcileCapturedSymmetric(
  transaction: PaymentTransactionRecord,
  fence: RecoveryFence,
): Promise<"noop" | "repaired" | "failed"> {
  let waafiStatus;
  try {
    waafiStatus = await queryWaafiTransactionStatus({
      transactionId: transaction.providerRef || null,
      referenceId: transaction.providerReferenceId || null,
    });
  } catch (error) {
    return "noop";
  }

  if (isWaafiCancelled(waafiStatus)) {
     await logError({
       type: CRITICAL_ERROR_TYPES.CRITICAL_SPLIT_BRAIN_DETECTED,
       transactionId: transaction.id,
       message: "SYMMETRIC SPLIT-BRAIN: Local CAPTURED but Provider says CANCELLED. Repairing toward Provider.",
       metadata: { waafiStatus: waafiStatus.params?.state }
     });

     await guardedTransitionPaymentTransactionState({
       fence,
       from: "captured",
       to: "failed",
       patch: { failedAt: Date.now(), failureReason: "Symmetric repair: Provider says cancelled" }
     });
     return "failed";
  }

  return "noop";
}

function getUnknownReconcileBackoffMs(retryCount: number) {
  const jitter = Math.floor(Math.random() * 1000);
  const exp = Math.min(UNKNOWN_RECONCILE_MAX_DELAY_MS, UNKNOWN_RECONCILE_BASE_DELAY_MS * 2 ** Math.max(0, retryCount));
  return exp + jitter;
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
      } else if (current.status === "held" || current.status === "pending_payment" || current.status === "paid") {
        const result = await reconcileEarlyStage(current, fence);
        if (result === "repaired") summary.repaired += 1;
        else if (result === "failed") summary.failed += 1;
      } else if (current.status === "cancel_pending") {
        const result = await reconcileCancelPending(current, fence);
        if (result === "failed") summary.failed += 1;
        else if (result === "repaired") summary.repaired += 1;
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
      ageMs: Date.now() - (toMillis(transaction.captureAttemptedAt) || 0),
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
async function reconcileEarlyStage(
  transaction: PaymentTransactionRecord,
  fence: RecoveryFence,
): Promise<"repaired" | "failed" | "unknown_retained" | "noop"> {
  const lastUpdate = toMillis(transaction.updatedAt) || Date.now();
  const age = Date.now() - lastUpdate;

  // 1. Pending Payment Recovery
  if (transaction.status === "pending_payment") {
    await getProviderDrivenPaymentStatus(transaction.id);
    return "repaired";
  }

  // 2. Paid -> Held Recovery
  if (transaction.status === "paid") {
    await getProviderDrivenPaymentStatus(transaction.id);
    return "repaired";
  }

  // 3. Held State Recovery (SLA enforcement & Resumption)
  if (transaction.status === "held") {
    // Case A: Never started
    if (!transaction.unlockStarted) {
      await triggerUnlockIfNeeded(transaction);
      return "repaired";
    }

    // Case B: Started but not finished (Check SLA)
    if (!transaction.unlockCompleted && !transaction.unlockFailed) {
      // If it's over the SLA (45s), we must auto-cancel to protect user funds
      if (age > HELD_STALL_SLA_MS) {
        await logError({
          type: CRITICAL_ERROR_TYPES.SLA_BREACH_DETECTED,
          transactionId: transaction.id,
          message: `SLA Breach: Transaction held for ${Math.floor(age/1000)}s without unlock completion. Auto-cancelling.`,
          metadata: { age, status: "held", unlockStarted: true }
        });

        const { cancelHold } = await import("@/lib/server/payment/process-payment");
        await cancelHold(transaction.id, "SLA_BREACH: Hardware flow timed out");
        return "failed";
      }

      // If it's older than 20s, try one resume attempt
      if (age > HELD_RESUME_COOLDOWN_MS) {
        await triggerUnlockIfNeeded(transaction);
        return "repaired";
      }
    }
  }

  return "noop";
}

/**
 * Phase 6: Reconcile transactions that were ordered to cancel but haven't been verified yet.
 */
async function reconcileCancelPending(
  transaction: PaymentTransactionRecord,
  fence: RecoveryFence,
): Promise<"repaired" | "failed" | "unknown_retained" | "noop"> {
  if (transaction.status !== "cancel_pending") return "noop";

  const age = Date.now() - (toMillis(transaction.updatedAt) || Date.now());

  let waafiStatus;
  try {
    waafiStatus = await queryWaafiTransactionStatus({
      transactionId: transaction.providerRef || null,
      referenceId: transaction.providerReferenceId || null,
    });
  } catch (error) {
    // If provider check keeps failing and we are way past SLA, move to failed locally but alert
    if (age > 120_000) {
      await logError({
        type: "CANCEL_UNRESOLVED",
        transactionId: transaction.id,
        message: "SLA BREACH: cancel_pending unresolved after 2 mins (Provider Error). Force marking as FAILED.",
        metadata: { age, error: String(error) }
      });
      await guardedTransitionPaymentTransactionState({
        fence,
        from: "cancel_pending",
        to: "failed",
        patch: { failedAt: Date.now(), failureReason: "SLA_BREACH: Provider verification timed out" }
      });
      return "failed";
    }
    return "unknown_retained";
  }

  // Case A: Confirmed Cancelled -> Move to terminal failed state
  if (isWaafiCancelled(waafiStatus)) {
    await guardedTransitionPaymentTransactionState({
      fence,
      from: "cancel_pending",
      to: "failed",
      patch: { 
        failedAt: Date.now(),
        failureReason: transaction.failureReason || "Cancellation verified by provider",
      }
    });
    return "failed";
  }

  // Case B: Confirmed Captured -> SPLIT BRAIN detected!
  if (isWaafiCaptured(waafiStatus)) {
    await logError({
      type: CRITICAL_ERROR_TYPES.CRITICAL_SPLIT_BRAIN_DETECTED,
      transactionId: transaction.id,
      message: "Split-brain detected during cancel_pending reconciliation: Provider says CAPTURED but system tried to CANCEL.",
      metadata: { waafiStatus: waafiStatus.params?.state }
    });

    await guardedTransitionPaymentTransactionState({
      fence,
      from: "cancel_pending",
      to: "captured",
      patch: { 
        capturedAt: Date.now(),
        rentalCreated: false, // Audit will catch and repair this
      }
    });
    return "repaired";
  }

  // Case C: Still pending or unresolved -> schedule retry
  await scheduleUnknownRetry(transaction, fence, "Cancellation verification pending at provider");
  return "unknown_retained";
}


async function reconcileVerified(
  transaction: PaymentTransactionRecord,
  fence: RecoveryFence,
): Promise<"repaired" | "failed" | "unknown_retained" | "noop"> {
  if (transaction.status !== "verified") {
    return "noop";
  }

  // Case 1: Capture was already confirmed by provider before a crash
  if (transaction.captureCompleted) {
     await guardedTransitionPaymentTransactionState({
       fence,
       from: "verified",
       to: "captured",
       patch: { capturedAt: Date.now(), rentalCreated: false }
     });
     return "repaired";
  }

  // Case 2: Capture was attempted but we don't know the result (crash/timeout)
  if (transaction.captureAttempted) {
    const age = Date.now() - (toMillis(transaction.captureAttemptedAt) || 0);
    
    // If it's very recent, wait for it to settle
    if (age < 30_000) {
      return "unknown_retained";
    }

    // Otherwise, check provider truth
    return reconcileVerifiedCrash(transaction, fence);
  }

  // Case 3: Capture was never even attempted (stalled)
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
    const ageMs = Date.now() - (toMillis(tx.captureAttemptedAt) || 0);

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
