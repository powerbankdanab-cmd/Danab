import { NextRequest, NextResponse } from "next/server";
import { 
  listStaleTransactionsForReconciliation,
  patchPaymentTransaction,
  finalizeCapture,
  cancelHold
} from "@/lib/server/payment-service";
import { logError } from "@/lib/server/alerts/log-error";

export const dynamic = "force-dynamic";

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

    // 2. Fetch Stale Transactions
    const staleTransactions = await listStaleTransactionsForReconciliation(20);
    
    const results = {
      processed: staleTransactions.length,
      cancelled: 0,
      repaired: 0,
      errors: 0
    };

    const workerId = `recon-worker-${Date.now()}`;

    // 3. Process Batch
    for (const tx of staleTransactions) {
      try {
        // Step 6: Safety Lock (30s)
        const now = Date.now();
        if (tx.recoveryLeaseUntil && tx.recoveryLeaseUntil > now) {
          continue; // Skip if already locked
        }

        // Apply lock
        await patchPaymentTransaction({
          id: tx.id,
          patch: {
            recoveryLeaseUntil: now + 30000, // 30s lock
            recoveryWorkerId: workerId,
          }
        });

        if (tx.status === "confirm_required") {
          // Rule: now - updatedAt > 60s (already filtered by query)
          await cancelHold(tx.id, "CONFIRM_TIMEOUT (Automatic reconciliation)");
          results.cancelled++;
          
          await logError({
            type: "CONFIRM_TIMEOUT_AUTO_CANCEL",
            transactionId: tx.id,
            stationCode: tx.station,
            message: "Transaction timed out on user confirmation screen and was auto-cancelled."
          });
        } 
        else if (tx.status === "captured" && !tx.rentalCreated) {
          // Rule: Status captured but no rental log created
          await finalizeCapture(tx.id);
          results.repaired++;

          await logError({
            type: "REPAIR_MISSING_RENTAL",
            transactionId: tx.id,
            stationCode: tx.station,
            message: "Captured transaction was missing a rental log. Repaired via reconciliation."
          });
        }
      } catch (err) {
        results.errors++;
        console.error(`Reconciliation error for ${tx.id}:`, err);
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    console.error("Reconciliation worker crashed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
