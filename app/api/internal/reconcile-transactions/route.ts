import { NextRequest, NextResponse } from "next/server";
import {
  listStaleTransactionsForReconciliation,
  listHeldTransactionsWithoutUnlock,
  claimTransactionRecovery,
  releaseTransactionRecovery,
  finalizeCapture,
  cancelHold,
  transitionPaymentTransactionState,
  resumePendingPayment,
} from "@/lib/server/payment-service";
import {
  getProviderDrivenPaymentStatus,
  triggerUnlockIfNeeded,
} from "@/lib/server/payment/status";
import { checkPaymentStatus } from "@/lib/server/payment/waafi";
import { logError, CRITICAL_ERROR_TYPES } from "@/lib/server/alerts/log-error";
import { getOptionalEnv } from "@/lib/server/env";

function isAuthorized(request: NextRequest) {
  const secret = getOptionalEnv("INTERNAL_CRON_TOKEN") || getOptionalEnv("CRON_SECRET") || getOptionalEnv("RECONCILE_CRON_SECRET");
  if (!secret) {
    return true; // For local dev without secret
  }

  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization") || "";
  return authHeader === `Bearer ${secret}`;
}

type TimestampLike = number | Date | { seconds?: number } | null | undefined;

function toMillis(value: TimestampLike): number | null {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value !== null && typeof value.seconds === "number") {
    return value.seconds * 1000;
  }
  return null;
}

async function reconcile(request: NextRequest) {
  try {
    // 1. Security Check
    if (!isAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Fetch Stale Transactions (Ordered by updatedAt)
    const staleTransactions = await listStaleTransactionsForReconciliation(20);

    const brokenHeld = await listHeldTransactionsWithoutUnlock(20);
    if (brokenHeld.length > 0) {
      await logError({
        type: "INVARIANT_BROKEN_HELD_WITHOUT_UNLOCK",
        message: "Held transactions were found without unlockStarted set",
        metadata: {
          brokenCount: brokenHeld.length,
          transactionIds: brokenHeld.map((tx) => tx.id),
        },
      });
    }

    const stats = {
      processed: staleTransactions.length,
      cancelled: 0,
      repaired: 0,
      locked: 0,
      errors: 0
    };

    const workerId = `recon-${Date.now()}`;

    // 3. Process Batch
    for (const staleTx of staleTransactions) {
      // Step 6: Atomic Safety Lock (30s lease)
      const claim = await claimTransactionRecovery({
        id: staleTx.id,
        workerId,
        leaseMs: 30000
      });

      if (!claim) {
        stats.locked++;
        continue;
      }

      const { record: tx, recoveryVersion } = claim;

      try {
        if (tx.status === "confirm_required") {
          const statusResult = await getProviderDrivenPaymentStatus(tx.id);
          if (statusResult.status === "verified") {
            stats.repaired++;
          } else if (statusResult.status === "failed") {
            stats.cancelled++;
          } else {
            stats.locked++;
          }

          const confirmAtMs = toMillis(tx.confirmRequiredAt ?? tx.updatedAt) ?? Date.now();
          await logError({
            type: "CONFIRM_TIMEOUT_AUTO_CANCEL",
            transactionId: tx.id,
            stationCode: tx.station,
            message: `[RECON] Processed stale confirm_required transaction (${Math.floor((Date.now() - confirmAtMs) / 1000)}s old)`,
            metadata: {
              action: "AUTO_CANCEL_TIMEOUT",
              station: tx.station,
              slotId: tx.delivery?.slotId,
              status: statusResult.status,
            },
          });
        }
        else if (tx.status === "captured" && !tx.rentalCreated) {
          await finalizeCapture(tx.id);
          stats.repaired++;

          await logError({
            type: "REPAIR_MISSING_RENTAL",
            transactionId: tx.id,
            stationCode: tx.station,
            message: "[RECON] Repaired missing rental for captured transaction",
            metadata: { action: "REPAIR_MISSING_RENTAL", station: tx.station, slotId: tx.delivery?.slotId }
          });
        }
        // Phase 4: capture_in_progress crash recovery
        else if (tx.status === "capture_in_progress") {
          await finalizeCapture(tx.id);
          stats.repaired++;

          await logError({
            type: "CAPTURE_IN_PROGRESS_RECOVERED",
            transactionId: tx.id,
            stationCode: tx.station,
            message: "[RECON] Recovered stale capture_in_progress transaction",
            metadata: {
              action: "CAPTURE_CRASH_RECOVERY",
              station: tx.station,
              captureCompleted: tx.captureCompleted,
              captureAttemptedAt: tx.captureAttemptedAt,
            }
          });
        }
        // Stuck verification recovery
        else if (tx.status === "verifying") {
          const verifyingAtMs = toMillis(tx.processingStartedAt ?? tx.updatedAt) ?? Date.now();
          if (Date.now() - verifyingAtMs > 30_000) {
            await logError({
              type: "VERIFICATION_STUCK",
              transactionId: tx.id,
              stationCode: tx.station,
              message: "[RECON] Stuck verification state exceeded timeout",
              metadata: {
                verifyingAgeMs: Date.now() - verifyingAtMs,
                unlockStarted: tx.unlockStarted,
              },
            });

            await cancelHold(tx.id, "Verification timed out while stuck in verifying");
            stats.cancelled++;
          } else {
            stats.locked++;
          }
        }
        // Phase 4: verified + captureAttempted crash recovery
        else if (tx.status === "verified" && tx.captureAttempted) {
          await finalizeCapture(tx.id);
          stats.repaired++;

          await logError({
            type: "VERIFIED_CRASH_RECOVERED",
            transactionId: tx.id,
            stationCode: tx.station,
            message: "[RECON] Recovered verified+captureAttempted crash case",
            metadata: {
              action: "VERIFIED_CRASH_RECOVERY",
              station: tx.station,
              captureAttemptedAt: tx.captureAttemptedAt,
            }
          });
        }
        else if (tx.status === "held" && tx.unlockStarted !== true) {
          try {
            await triggerUnlockIfNeeded(tx);
            stats.repaired++;

            await logError({
              type: "HELD_UNLOCK_RECOVERY",
              transactionId: tx.id,
              stationCode: tx.station,
              message: "[RECON] Triggered unlock recovery for held transaction",
              metadata: {
                action: "HELD_UNLOCK_RECOVERY",
                station: tx.station,
                unlockStarted: tx.unlockStarted,
              },
            });
          } catch (heldRecoveryError) {
            stats.errors++;
            await logError({
              type: CRITICAL_ERROR_TYPES.RECONCILIATION_FAILED,
              transactionId: tx.id,
              stationCode: tx.station,
              message: "[RECON] Failed to recover held transaction",
              metadata: {
                error: heldRecoveryError instanceof Error ? heldRecoveryError.message : String(heldRecoveryError),
                station: tx.station,
              },
            });
          }
        } else if (tx.status === "pending_payment") {
          const paymentResult = await checkPaymentStatus(
            tx.providerRef,
            tx.providerReferenceId,
          );

          if (paymentResult === "paid") {
            // Transition to held and resume hardware verification before capture
            try {
              await resumePendingPayment(tx);
              stats.repaired++;

              await logError({
                type: "ASYNC_PAYMENT_CONFIRMED",
                transactionId: tx.id,
                message: "[RECON] Payment confirmed and ejection verification resumed for pending transaction",
                metadata: { action: "PAYMENT_CONFIRMED", station: tx.station }
              });
            } catch (paymentResumeError) {
              await logError({
                type: CRITICAL_ERROR_TYPES.RECONCILIATION_FAILED,
                transactionId: tx.id,
                message: "[RECON] Failed to resume pending payment after async confirmation",
                metadata: {
                  error: paymentResumeError instanceof Error ? paymentResumeError.message : String(paymentResumeError),
                  station: tx.station,
                }
              });
              stats.errors++;
            }
          } else if (
            (paymentResult === "cancelled" || paymentResult === "failed") &&
            (Date.now() - (toMillis(tx.createdAt) ?? Date.now())) > 120_000
          ) { // 2 minutes
            await cancelHold(tx.id, "PAYMENT_TIMEOUT (Async payment not completed)");
            stats.cancelled++;

            const createdAtMs = toMillis(tx.createdAt) ?? Date.now();
            await logError({
              type: "ASYNC_PAYMENT_TIMEOUT",
              transactionId: tx.id,
              stationCode: tx.station,
              message: `[RECON] Auto-cancelled pending payment (${Math.floor((Date.now() - createdAtMs) / 1000)}s old)`,
              metadata: { action: "PAYMENT_TIMEOUT", station: tx.station }
            });
          }
          else {
            // Still pending or unknown - retry next cycle
            stats.locked++;
          }
        }
      } catch (err) {
        stats.errors++;
        console.error(`Reconciliation failed for ${tx.id}:`, err);
      } finally {
        await releaseTransactionRecovery(tx.id, workerId, recoveryVersion);
      }
    }

    return NextResponse.json(stats);
  } catch (error) {
    console.error("Reconciliation worker crashed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
