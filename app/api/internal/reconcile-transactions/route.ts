import { NextRequest, NextResponse } from "next/server";
import {
  listStaleTransactionsForReconciliation,
  listHeldTransactionsWithoutUnlock,
  claimTransactionRecovery,
  releaseTransactionRecovery,
  finalizeCapture,
  cancelHold,
} from "@/lib/server/payment-service";
import {
  triggerUnlockIfNeeded,
  reconcileTransactionStatus,
} from "@/lib/server/payment/status";
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

export async function GET(request: NextRequest) {
  return reconcile(request);
}

export async function POST(request: NextRequest) {
  return reconcile(request);
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
        if (tx.status === "confirm_required" || tx.status === "pending_payment" || tx.status === "paid") {
          const statusResult = await reconcileTransactionStatus(tx.id);
          if (statusResult.status === "verified" || statusResult.status === "held") {
            stats.repaired++;
          } else if (statusResult.status === "failed") {
            stats.cancelled++;
          } else {
            stats.locked++;
          }
        }
        else if (tx.status === "captured" && !tx.rentalCreated) {
          await finalizeCapture(tx.id);
          stats.repaired++;
        }
        // Phase 4: capture_in_progress crash recovery
        else if (tx.status === "capture_in_progress") {
          await finalizeCapture(tx.id);
          stats.repaired++;
        }
        // Stuck verification recovery
        else if (tx.status === "verifying") {
          const verifyingAtMs = toMillis(tx.processingStartedAt ?? tx.updatedAt) ?? Date.now();
          if (Date.now() - verifyingAtMs > 30_000) {
            await cancelHold(tx.id, "Verification timed out while stuck in verifying");
            stats.cancelled++;
          } else {
            stats.locked++;
          }
        }
        // Phase 4: verified crash recovery
        else if (tx.status === "verified" && !tx.captureCompleted) {
          await finalizeCapture(tx.id);
          stats.repaired++;
        }
        else if (tx.status === "held" && tx.unlockStarted !== true) {
          const heldAtMs = toMillis(tx.heldAt ?? tx.updatedAt) ?? Date.now();
          const ageS = (Date.now() - heldAtMs) / 1000;
          
          if (ageS > 5) {
            try {
              await triggerUnlockIfNeeded(tx.id);
              stats.repaired++;
              
              await logError({
                type: "AUTO_REPAIR_HELD_EXECUTION",
                transactionId: tx.id,
                message: `[RECON] Proactively triggered unlock for held transaction (${Math.floor(ageS)}s old)`,
                metadata: { ageS, status: tx.status }
              });
            } catch (heldRecoveryError) {
              stats.errors++;
            }
          } else {
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
