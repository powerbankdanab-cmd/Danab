import { NextRequest, NextResponse } from "next/server";
import { 
  listStaleTransactionsForReconciliation,
  claimTransactionRecovery,
  releaseTransactionRecovery,
  finalizeCapture,
  cancelHold
} from "@/lib/server/payment-service";
import { logError, CRITICAL_ERROR_TYPES } from "@/lib/server/alerts/log-error";

export async function GET(request: NextRequest) {
  return reconcile(request);
}

export async function POST(request: NextRequest) {
  return reconcile(request);
}

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
            message: `[RECON] Auto-cancelled stale confirmation (${Math.floor((Date.now() - tx.updatedAt)/1000)}s old)`,
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
