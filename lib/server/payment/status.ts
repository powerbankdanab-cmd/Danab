import { HttpError } from "@/lib/server/payment/errors";
import {
  completePhase2Transaction,
  getPaymentTransaction,
  PaymentTransactionRecord,
  transitionPaymentTransactionState,
} from "@/lib/server/payment/transactions";
import { checkPaymentStatusDetailed } from "@/lib/server/payment/waafi";
import { releaseBattery } from "@/lib/server/payment/heycharge";
import { verifyDeliveryWithConfidence } from "@/lib/server/payment/delivery-verification";

const PAYMENT_PENDING_TIMEOUT_MS = 3 * 60_000;

export type PaymentStatusResponse = {
  status: "pending_payment" | "paid" | "processing" | "verified" | "failed";
  reason_code?: "USER_CANCELLED" | "TIMEOUT" | "PROVIDER_ERROR";
  failureReason?: "USER_CANCELLED" | "TIMEOUT" | "PROVIDER_ERROR";
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

  if (failureReason) {
    return "PROVIDER_ERROR";
  }

  return undefined;
}

function toMillis(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }

  if (
    value &&
    typeof value === "object" &&
    "toMillis" in value &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    return (value as { toMillis: () => number }).toMillis();
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

  if (transaction.status === "verified") {
    return { status: "verified" };
  }

  if (transaction.status === "paid") {
    return { status: "paid" };
  }

  return { status: "pending_payment" };
}

async function handlePaidTransaction(
  transaction: PaymentTransactionRecord,
): Promise<PaymentStatusResponse> {
  if (transaction.status !== "paid") {
    return buildStatusResponse(transaction);
  }

  if (!transaction.delivery) {
    console.error("unable_to_start_unlock_flow", {
      transactionId: transaction.id,
      reason: "missing_delivery_payload",
    });

    return { status: "paid" };
  }

  const currentTransaction = await getPaymentTransaction(transaction.id);
  if (!currentTransaction) {
    throw new HttpError(404, "Transaction not found");
  }

  if (currentTransaction.status !== "paid") {
    return buildStatusResponse(currentTransaction);
  }

  try {
    await transitionPaymentTransactionState({
      id: transaction.id,
      from: "paid",
      to: "processing",
    });
  } catch {
    const reloaded = await getPaymentTransaction(transaction.id);
    if (!reloaded) {
      throw new HttpError(404, "Transaction not found");
    }
    return buildStatusResponse(reloaded);
  }

  console.info("payment_processing", { transactionId: transaction.id });

  try {
    await releaseBattery({
      imei: transaction.delivery.imei,
      batteryId: transaction.delivery.batteryId,
      slotId: transaction.delivery.slotId,
    });

    const verification = await verifyDeliveryWithConfidence(
      transaction.delivery.imei,
      transaction.delivery.batteryId,
      transaction.delivery.slotId,
      {
        stationCode: transaction.delivery.stationCode,
        phoneNumber:
          transaction.delivery.canonicalPhoneNumber || transaction.phone,
        transactionId: transaction.id,
      },
    );

    if (verification.confidence === "HIGH") {
      await transitionPaymentTransactionState({
        id: transaction.id,
        from: "processing",
        to: "verified",
        patch: { verifiedAt: Date.now() },
      });

      console.info("payment_verified", {
        transactionId: transaction.id,
        confidence: verification.confidence,
      });

      return { status: "verified" };
    }

    await transitionPaymentTransactionState({
      id: transaction.id,
      from: "processing",
      to: "failed",
      patch: { failureReason: "PROVIDER_ERROR" },
    });

    console.info("payment_failed", {
      transactionId: transaction.id,
      failureReason: "PROVIDER_ERROR",
      confidence: verification.confidence,
    });

    return {
      status: "failed",
      reason_code: "PROVIDER_ERROR",
      failureReason: "PROVIDER_ERROR",
    };
  } catch (error) {
    await transitionPaymentTransactionState({
      id: transaction.id,
      from: "processing",
      to: "failed",
      patch: { failureReason: "PROVIDER_ERROR" },
    });

    console.error("payment_unlock_error", {
      transactionId: transaction.id,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      status: "failed",
      reason_code: "PROVIDER_ERROR",
      failureReason: "PROVIDER_ERROR",
    };
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
    return handlePaidTransaction(transaction);
  }

  if (transaction.status === "processing") {
    return buildStatusResponse(transaction);
  }

  if (transaction.status === "verified") {
    return buildStatusResponse(transaction);
  }

  if (transaction.status === "failed") {
    return buildStatusResponse(transaction);
  }

  const createdAtMs = toMillis(transaction.createdAt);
  if (
    transaction.status === "pending_payment" &&
    createdAtMs !== null &&
    Date.now() - createdAtMs > PAYMENT_PENDING_TIMEOUT_MS
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

    return handlePaidTransaction(updatedTransaction);
  }

  return { status: "pending_payment" };
}
