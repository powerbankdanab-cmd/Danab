import { HttpError } from "@/lib/server/payment/errors";
import {
  completePhase2Transaction,
  getPaymentTransaction,
} from "@/lib/server/payment/transactions";
import { checkPaymentStatusDetailed } from "@/lib/server/payment/waafi";

const PAYMENT_PENDING_TIMEOUT_MS = 3 * 60_000;

export type PaymentStatusResponse = {
  status: "pending_payment" | "paid" | "failed";
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

export async function getProviderDrivenPaymentStatus(
  transactionId: string,
): Promise<PaymentStatusResponse> {
  const transaction = await getPaymentTransaction(transactionId);

  if (!transaction) {
    throw new HttpError(404, "Transaction not found");
  }

  if (transaction.status === "paid") {
    return { status: "paid" };
  }

  if (transaction.status === "failed") {
    return {
      status: "failed",
      reason_code: toReasonCode(transaction.failureReason),
      failureReason: toReasonCode(transaction.failureReason),
    };
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
        ? String(providerCheck.raw.responseCode)
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
    const status = await completePhase2Transaction({
      id: transactionId,
      status: "paid",
    });

    console.info("payment_paid", { transactionId });

    return { status };
  }

  return { status: "pending_payment" };
}
