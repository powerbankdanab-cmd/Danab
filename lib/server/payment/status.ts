import { HttpError } from "@/lib/server/payment/errors";
import {
  completePhase2Transaction,
  getPaymentTransaction,
  patchPaymentTransaction,
  transitionPaymentTransactionState,
  PAYMENT_TRANSACTIONS_COLLECTION,
  PaymentTransactionRecord,
} from "@/lib/server/payment/transactions";
import { checkPaymentStatusDetailed } from "@/lib/server/payment/waafi";
import { getDb } from "@/lib/server/firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { releaseBattery } from "@/lib/server/payment/heycharge";

const PAYMENT_PENDING_TIMEOUT_MS = 3 * 60_000;
const PROCESSING_TIMEOUT_MS = 30_000;

export type PaymentStatusResponse = {
  status:
  | "pending_payment"
  | "paid"
  | "processing"
  | "verifying"
  | "verified"
  | "failed";
  reason_code?:
  | "USER_CANCELLED"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "UNLOCK_TIMEOUT";
  failureReason?:
  | "USER_CANCELLED"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "UNLOCK_TIMEOUT";
  unlockStarted?: boolean;
};

function toReasonCode(
  failureReason: unknown,
): PaymentStatusResponse["reason_code"] {
  if (failureReason === "USER_CANCELLED") {
    return "USER_CANCELLED";
  }

  if (failureReason === "TIMEOUT") {
    return "TIMEOUT";
  }

  if (failureReason === "UNLOCK_TIMEOUT") {
    return "UNLOCK_TIMEOUT";
  }

  if (failureReason) {
    return "PROVIDER_ERROR";
  }

  return undefined;
}

function toMillis(value: unknown): number | null {
  if (!value) return null;

  if (typeof value === "number") return value;

  if (value instanceof Date) return value.getTime();

  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }

  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { seconds?: unknown }).seconds === "number"
  ) {
    return (value as { seconds: number }).seconds * 1000;
  }

  return null;
}

function buildStatusResponse(
  transaction: PaymentTransactionRecord,
): PaymentStatusResponse {
  if (transaction.status === "failed") {
    return {
      status: "failed",
      reason_code: toReasonCode(transaction.failureReason),
      failureReason: toReasonCode(transaction.failureReason),
    };
  }

  if (transaction.status === "processing") {
    return { status: "processing" };
  }

  if (transaction.status === "verifying") {
    return { status: "verifying" };
  }

  if (transaction.status === "verified") {
    return { status: "verified" };
  }

  if (transaction.status === "paid") {
    return { status: "paid" };
  }

  return { status: "pending_payment" };
}

export async function runUnlockIfNeeded(
  transaction: PaymentTransactionRecord,
): Promise<void> {
  if (transaction.status !== "paid" || transaction.unlockStarted) {
    return;
  }

  if (!transaction.delivery) {
    console.error("unable_to_start_unlock_flow", {
      transactionId: transaction.id,
      reason: "missing_delivery_payload",
    });
    return;
  }

  const db = getDb();
  const docRef = db
    .collection(PAYMENT_TRANSACTIONS_COLLECTION)
    .doc(transaction.id);

  let shouldUnlock = false;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new HttpError(404, "Transaction not found");
    }

    const fresh = snap.data() as PaymentTransactionRecord;
    if (fresh.status !== "paid" || fresh.unlockStarted) {
      return;
    }

    tx.update(docRef, {
      unlockStarted: true,
      status: "processing",
      processingStartedAt: new Date(),
      updatedAt: Date.now(),
      updatedAtTs: Timestamp.now(),
    });

    shouldUnlock = true;
  });

  if (!shouldUnlock) {
    return;
  }

  console.info("unlock_started", { transactionId: transaction.id });

  try {
    await releaseBattery({
      imei: transaction.delivery.imei,
      batteryId: transaction.delivery.batteryId,
      slotId: transaction.delivery.slotId,
    });

    await patchPaymentTransaction({
      id: transaction.id,
      patch: {
        status: "verifying",
        updatedAt: Date.now(),
        updatedAtTs: Timestamp.now(),
      },
    });
  } catch (error) {
    console.error("payment_unlock_error", {
      transactionId: transaction.id,
      error: error instanceof Error ? error.message : String(error),
    });

    await patchPaymentTransaction({
      id: transaction.id,
      patch: {
        status: "failed",
        failureReason: "PROVIDER_ERROR",
        updatedAt: Date.now(),
        updatedAtTs: Timestamp.now(),
      },
    });
  }
}

export async function getProviderDrivenPaymentStatus(
  transactionId: string,
): Promise<PaymentStatusResponse> {
  const transaction = await getPaymentTransaction(transactionId);

  if (!transaction) {
    throw new HttpError(404, "Transaction not found");
  }

  if (transaction.status === "paid") {
    if (!transaction.unlockStarted) {
      console.info("unlock_fallback_triggered", {
        transactionId,
      });

      runUnlockIfNeeded(transaction).catch((err) => {
        console.error("unlock_fallback_failed", {
          transactionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return buildStatusResponse(transaction);
  }

  if (transaction.status === "processing") {
    const processingStartedAtMs = toMillis(transaction.processingStartedAt);
    if (
      processingStartedAtMs !== null &&
      Date.now() - processingStartedAtMs > PROCESSING_TIMEOUT_MS
    ) {
      await transitionPaymentTransactionState({
        id: transactionId,
        from: "processing",
        to: "failed",
        patch: {
          failureReason: "UNLOCK_TIMEOUT",
        },
      });

      console.info("unlock_timeout", { transactionId });
      console.info("payment_failed", {
        transactionId,
        failureReason: "UNLOCK_TIMEOUT",
      });

      return {
        status: "failed",
        reason_code: "UNLOCK_TIMEOUT",
        failureReason: "UNLOCK_TIMEOUT",
      };
    }

    return buildStatusResponse(transaction);
  }

  if (transaction.status === "verifying") {
    return buildStatusResponse(transaction);
  }

  if (transaction.status === "verified") {
    return buildStatusResponse(transaction);
  }

  if (transaction.status === "failed") {
    return buildStatusResponse(transaction);
  }

  const createdAtMs = toMillis(transaction.createdAt);
  if (!createdAtMs) {
    console.error("MISSING createdAt - cannot evaluate timeout", {
      transactionId,
      createdAt: transaction.createdAt,
    });
  } else {
    const elapsedMs = Date.now() - createdAtMs;
    console.log("TIME CHECK:", {
      transactionId,
      createdAtMs,
      now: Date.now(),
      elapsedMs,
    });

    if (
      transaction.status === "pending_payment" &&
      elapsedMs >= PAYMENT_PENDING_TIMEOUT_MS
    ) {
      const status = await completePhase2Transaction({
        id: transactionId,
        status: "failed",
        failureReason: "TIMEOUT",
      });

      console.info("payment_failed", {
        transactionId,
        failureReason: "TIMEOUT",
      });

      return { status, reason_code: "TIMEOUT", failureReason: "TIMEOUT" };
    }
  }

  if (!transaction.providerRef) {
    console.info("payment_status_checked", {
      transactionId,
      providerRef: null,
      providerStatus: "missing_provider_ref",
    });

    return { status: "pending_payment" };
  }

  const providerCheck = await checkPaymentStatusDetailed(
    transaction.providerRef,
    null,
  );

  console.info("payment_status_checked", {
    transactionId,
    providerRef: transaction.providerRef,
    providerStatus: providerCheck.status,
    providerResponseCode:
      providerCheck.raw?.responseCode !== undefined
        ? String(providerCheck.raw?.responseCode)
        : null,
    providerErrorCode: providerCheck.raw?.errorCode || null,
    providerState: providerCheck.raw?.params?.state || null,
    providerMessage: providerCheck.raw?.responseMsg || null,
  });

  if (providerCheck.error) {
    console.info("provider_error", {
      transactionId,
      providerRef: transaction.providerRef,
      error: providerCheck.error,
    });

    return { status: "pending_payment" };
  }

  if (providerCheck.status === "cancelled") {
    const status = await completePhase2Transaction({
      id: transactionId,
      status: "failed",
      failureReason: "USER_CANCELLED",
    });

    console.info("payment_failed", {
      transactionId,
      failureReason: "USER_CANCELLED",
    });

    return {
      status,
      reason_code: "USER_CANCELLED",
      failureReason: "USER_CANCELLED",
    };
  }

  if (providerCheck.status === "failed") {
    const status = await completePhase2Transaction({
      id: transactionId,
      status: "failed",
      failureReason: "PROVIDER_FAILED",
    });

    console.info("payment_failed", {
      transactionId,
      failureReason: "PROVIDER_FAILED",
    });

    return {
      status,
      reason_code: "PROVIDER_ERROR",
      failureReason: "PROVIDER_ERROR",
    };
  }

  if (providerCheck.status === "paid") {
    await completePhase2Transaction({
      id: transactionId,
      status: "paid",
    });

    console.info("payment_paid", { transactionId });

    const updatedTransaction = await getPaymentTransaction(transactionId);
    if (!updatedTransaction) {
      throw new HttpError(404, "Transaction not found");
    }

    return buildStatusResponse(updatedTransaction);
  }

  return { status: "pending_payment" };
}
