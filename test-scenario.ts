import { getDb } from "./lib/server/firebase-admin";
import { finalizeCapture } from "./lib/server/payment-service";
import { logError, CRITICAL_ERROR_TYPES } from "./lib/server/alerts/log-error";
import { PAYMENT_TRANSACTIONS_COLLECTION } from "./lib/server/payment/transactions";

async function runTest() {
  const db = getDb();
  const txId = `test_sim_${Date.now()}`;

  console.log("1. Simulating 'captured && rentalCreated = false' state...");
  await db.collection(PAYMENT_TRANSACTIONS_COLLECTION).doc(txId).set({
    id: txId,
    status: "captured",
    rentalCreated: false,
    captureCompleted: true,
    amount: 10,
    phone: "252610000000",
    station: "TEST01",
    delivery: {
      batteryId: "BATT_TEST",
      slotId: "1",
      imei: "1234567890",
      stationCode: "TEST01",
      canonicalPhoneNumber: "252610000000",
      requestedPhoneNumber: "610000000",
      phoneAuthority: "waafi",
    },
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
  });

  console.log("2. Manually triggering the Tier 1 alert for RENTAL_CREATION_FAILED (as if it just failed)...");
  await logError({
    type: CRITICAL_ERROR_TYPES.RENTAL_CREATION_FAILED,
    transactionId: txId,
    message: "CRITICAL: Payment captured but rental creation failed (SIMULATION)",
    stationCode: "TEST01",
  });

  console.log("3. Running finalizeCapture (which is what reconciliation does)...");
  try {
    await finalizeCapture(txId);
  } catch (e: any) {
    console.error("Error during finalizeCapture:", e.message);
  }

  const updatedTx = await db.collection(PAYMENT_TRANSACTIONS_COLLECTION).doc(txId).get();
  console.log("4. Final state in Firestore:");
  console.log(updatedTx.data());

  process.exit(0);
}

runTest().catch(console.error);
