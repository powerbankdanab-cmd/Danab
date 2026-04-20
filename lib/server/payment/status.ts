import { logError } from "@/lib/server/alerts/log-error";
import { HttpError } from "@/lib/server/payment/errors";
import { resumePendingPayment } from "@/lib/server/payment/process-payment";
import {
  getPaymentTransaction,
  PaymentTransactionRecord,
  transitionPaymentTransactionState,
} from "@/lib/server/payment/transactions";
import { checkPaymentStatus } from "@/lib/server/payment/waafi";

export type PaymentStatusReason = "USER_CANCELLED" | "INSUFFICIENT_BALANCE" | "WRONG_PIN" | "TIMEOUT" | "PROVIDER_ERROR";

export type PaymentStatusResponse = {
  status: "pending_payment" | "processing" | "confirm_required" | "payment_confirmed" | "failed";
  reason_code?: PaymentStatusReason;
  message?: string;
  transactionId: string;
  battery_id?: string;
  slot_id?: string;
};

function toFinalResponse(transaction: PaymentTransactionRecord): PaymentStatusResponse {
  if (transaction.status === "failed") {
    const reason = String(transaction.failureReason || "").toLowerCase().includes("cancel")
      ? "USER_CANCELLED"
      : "PROVIDER_ERROR";

    return {
      status: "failed",
      reason_code: reason,
      transactionId: transaction.id,
    };
  }

  if (transaction.status === "captured") {
    return {
      status: "payment_confirmed",
      transactionId: transaction.id,
      battery_id: transaction.delivery?.batteryId,
      slot_id: transaction.delivery?.slotId,
    };
  }

  if (transaction.status === "confirm_required") {
    return {
      status: "confirm_required",
      transactionId: transaction.id,
    };
  }

  if (transaction.status === "pending_payment") {
    return {
      status: "pending_payment",
      transactionId: transaction.id,
    };
  }

  // held, verified, capture_unknown, resolving → processing
  return {
    status: "processing",
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
        failureReason: "USER_CANCELLED",
      },
    }).catch(() => undefined);

    console.info("PAYMENT_USER_CANCELLED", { transactionId });

    return {
      status: "failed",
      reason_code: "USER_CANCELLED",
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
        failureReason: "PROVIDER_ERROR",
      },
    }).catch(() => undefined);

    console.info("PAYMENT_FAILED", { transactionId });

    return {
      status: "failed",
      reason_code: "PROVIDER_ERROR",
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
