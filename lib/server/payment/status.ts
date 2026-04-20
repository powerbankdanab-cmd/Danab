import { logError } from "@/lib/server/alerts/log-error";
import { HttpError } from "@/lib/server/payment/errors";
import { resumePendingPayment } from "@/lib/server/payment/process-payment";
import {
  getPaymentTransaction,
  PaymentTransactionRecord,
  transitionPaymentTransactionState,
} from "@/lib/server/payment/transactions";
import { checkPaymentStatus } from "@/lib/server/payment/waafi";

export type PaymentStatusReason = "user_cancelled" | "timeout" | "error";

export type PaymentStatusResponse = {
  status: "pending_payment" | "payment_confirmed" | "failed";
  reason?: PaymentStatusReason;
  transactionId: string;
  battery_id?: string;
  slot_id?: string;
};

function toFinalResponse(transaction: PaymentTransactionRecord): PaymentStatusResponse {
  if (transaction.status === "failed") {
    const reason = String(transaction.failureReason || "").toLowerCase().includes("cancel")
      ? "user_cancelled"
      : undefined;

    return {
      status: "failed",
      reason,
      transactionId: transaction.id,
    };
  }

  if (
    transaction.status === "captured" ||
    transaction.status === "verified" ||
    transaction.status === "held" ||
    transaction.status === "confirm_required" ||
    transaction.status === "capture_unknown"
  ) {
    return {
      status: "payment_confirmed",
      transactionId: transaction.id,
      battery_id: transaction.delivery?.batteryId,
      slot_id: transaction.delivery?.slotId,
    };
  }

  return {
    status: "pending_payment",
    transactionId: transaction.id,
  };
}

export async function getProviderDrivenPaymentStatus(
  transactionId: string,
): Promise<PaymentStatusResponse> {
  const transaction = await getPaymentTransaction(transactionId);

  if (!transaction) {
    throw new HttpError(404, "Transaction not found");
  }

  if (transaction.status !== "pending_payment") {
    return toFinalResponse(transaction);
  }

  const providerStatus = await checkPaymentStatus(
    transaction.providerRef,
    transaction.providerReferenceId,
  );

  if (providerStatus === "pending") {
    console.info("PAYMENT_PENDING_STARTED", { transactionId });
    return {
      status: "pending_payment",
      transactionId,
    };
  }

  if (providerStatus === "cancelled") {
    await transitionPaymentTransactionState({
      id: transactionId,
      from: "pending_payment",
      to: "failed",
      patch: {
        failedAt: Date.now(),
        failureReason: "user_cancelled",
      },
    }).catch(() => undefined);

    console.info("PAYMENT_USER_CANCELLED", { transactionId });

    return {
      status: "failed",
      reason: "user_cancelled",
      transactionId,
    };
  }

  if (providerStatus === "failed") {
    await transitionPaymentTransactionState({
      id: transactionId,
      from: "pending_payment",
      to: "failed",
      patch: {
        failedAt: Date.now(),
        failureReason: "provider_failed",
      },
    }).catch(() => undefined);

    console.info("PAYMENT_FAILED", { transactionId });

    return {
      status: "failed",
      reason: "error",
      transactionId,
    };
  }

  if (providerStatus === "paid") {
    try {
      await resumePendingPayment(transaction);
      const latest = await getPaymentTransaction(transactionId);
      console.info("PAYMENT_CONFIRMED", { transactionId });
      return toFinalResponse(latest || transaction);
    } catch (error) {
      await logError({
        type: "PAYMENT_CONFIRM_AFTER_PENDING_FAILED",
        transactionId,
        stationCode: transaction.station,
        phoneNumber: transaction.phone,
        message: "Provider returned PAID but pending resume failed",
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });

      return {
        status: "pending_payment",
        reason: "error",
        transactionId,
      };
    }
  }

  return {
    status: "pending_payment",
    reason: "error",
    transactionId,
  };
}
