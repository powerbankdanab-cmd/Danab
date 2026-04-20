import { NextRequest, NextResponse } from "next/server";
import {
  listStaleTransactionsForReconciliation,
  claimTransactionRecovery,
  releaseTransactionRecovery,
  finalizeCapture,
  cancelHold,
  transitionPaymentTransactionState
} from "@/lib/server/payment-service";
import { checkPaymentStatus } from "@/lib/server/payment/waafi";
import { logError, CRITICAL_ERROR_TYPES } from "@/lib/server/alerts/log-error";

async function reconcile(request: NextRequest) {
  try {
    // 1. Security Check
    const authHeader = request.headers.get("Authorization");
    const cronToken = process.env.INTERNAL_CRON_TOKEN;

    if (cronToken && authHeader !== `Bearer ${cronToken}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Fetch Stale Transactions (Ordered by updatedAt)
    const staleTransactions = await listStaleTransactionsForReconciliation(20);

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
          await cancelHold(tx.id, "AUTO_CANCEL_TIMEOUT (Distributed reconciliation)");
          stats.cancelled++;

          await logError({
            type: "CONFIRM_TIMEOUT_AUTO_CANCEL",
            transactionId: tx.id,
            stationCode: tx.station,
            message: `[RECON] Auto-cancelled stale confirmation (${Math.floor((Date.now() - tx.updatedAt) / 1000)}s old)`,
            metadata: { action: "AUTO_CANCEL_TIMEOUT", station: tx.station, slotId: tx.delivery?.slotId }
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
        else if (tx.status === "pending_payment") {
          const paymentResult = await checkPaymentStatus(tx);

          if (paymentResult.status === "paid") {
            // Update transaction with providerRef if we got it
            if (paymentResult.transactionId && !tx.providerRef) {
              await transitionPaymentTransactionState({
                id: tx.id,
                from: "pending_payment",
                to: "pending_payment",
                patch: {
                  providerRef: paymentResult.transactionId,
                  updatedAt: Date.now()
                }
              });
            }

            // Transition to verified and finalize capture
            await transitionPaymentTransactionState({
              id: tx.id,
              from: "pending_payment",
              to: "verified",
              patch: { verifiedAt: Date.now() }
            });

            try {
              await finalizeCapture(tx.id);
              stats.repaired++;

              await logError({
                type: "ASYNC_PAYMENT_CONFIRMED",
                transactionId: tx.id,
                message: "[RECON] Payment confirmed and finalized for pending transaction",
                metadata: { action: "PAYMENT_CONFIRMED", station: tx.station }
              });
            } catch (finalizeError) {
              // If finalize fails, mark for manual review
              await logError({
                type: CRITICAL_ERROR_TYPES.RECONCILIATION_FAILED,
                transactionId: tx.id,
                message: "[RECON] Failed to finalize confirmed payment",
                metadata: {
                  error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
                  station: tx.station
                }
              });
              stats.errors++;
            }
          }
          else if (paymentResult.status === "not_paid" && (Date.now() - tx.createdAt) > 120_000) { // 2 minutes
            await cancelHold(tx.id, "PAYMENT_TIMEOUT (Async payment not completed)");
            stats.cancelled++;

            await logError({
              type: "ASYNC_PAYMENT_TIMEOUT",
              transactionId: tx.id,
              stationCode: tx.station,
              message: `[RECON] Auto-cancelled pending payment (${Math.floor((Date.now() - tx.createdAt) / 1000)}s old)`,
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
