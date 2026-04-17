import { BatteryStateConflictError } from "@/lib/server/payment/battery-state";
import {
  ensureBatteryRentedForTransaction,
  ensureBatteryReturnedForTransaction,
} from "@/lib/server/payment/battery-state";
import {
  createRentalLog,
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

  const delivery = transaction.delivery;
  if (!delivery) {
    throw new Error("Captured transaction is missing delivery context");
  }

  try {
    const rentalRef = await createRentalLog({
      imei: delivery.imei,
      stationCode: delivery.stationCode,
      batteryId: delivery.batteryId,
      slotId: delivery.slotId,
      phoneNumber: delivery.canonicalPhoneNumber,
      requestedPhoneNumber: delivery.requestedPhoneNumber,
      amount: transaction.amount,
      transactionId: providerRef,
      issuerTransactionId: transaction.providerIssuerRef || null,
      referenceId: transaction.providerReferenceId || null,
      phoneAuthority: delivery.phoneAuthority,
      waafiAudit: transaction.waafiAudit,
    });

    await ensureBatteryRentedForTransaction({
      batteryId: delivery.batteryId,
      imei: delivery.imei,
      stationCode: delivery.stationCode,
      slotId: delivery.slotId,
      rentalId: rentalRef.id,
      transactionId: providerRef,
      phoneNumber: delivery.canonicalPhoneNumber,
      requestedPhoneNumber: delivery.requestedPhoneNumber,
      phoneAuthority: delivery.phoneAuthority,
      amount: transaction.amount,
      issuerTransactionId: transaction.providerIssuerRef || null,
      referenceId: transaction.providerReferenceId || null,
    });

    if (fence) {
      await guardedPatchPaymentTransaction({
        fence,
        patch: {
          rentalCreated: true,
          rentalId: rentalRef.id,
        },
      });
    }
    await updateRentalUnlockStatus(rentalRef.id, "unlocked");
    return "created";
  } catch (error) {
    if (error instanceof BatteryStateConflictError) {
      const byTx = await getRentalByTransactionId(providerRef);
      if (byTx) {
        if (fence) {
          await guardedPatchPaymentTransaction({
            fence,
            patch: {
              rentalCreated: true,
              rentalId: byTx.id,
            },
          });
        }
        await updateRentalUnlockStatus(byTx.id, "unlocked");
        return "already_exists";
      }
    }
    throw error;
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

async function scheduleUnknownRetry(
  transaction: PaymentTransactionRecord,
  fence: RecoveryFence,
  reason: string,
) {
  const retryCount = (transaction.unknownRetryCount || 0) + 1;
  const createdAt = transaction.createdAt || Date.now();
  const ageMs = Date.now() - createdAt;
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
  const candidates = await listTransactionsForReconciliation(limit);

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
      }
    } catch (error) {
      summary.errors.push({
        id: candidate.id,
        reason: error instanceof Error ? error.message : String(error),
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
