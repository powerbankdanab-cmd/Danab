import { NextRequest, NextResponse } from "next/server";

import {
  createMinimalTransaction,
  patchPhase2Transaction,
  logTransactionEvent,
} from "@/lib/server/payment/transactions";
import {
  extractWaafiIds,
  requestWaafiPreauthorization,
  detectFailureReason,
} from "@/lib/server/payment/waafi";
import { 
  ensureDeliveryContext, 
  triggerUnlockIfNeeded, 
  isStationHealthy 
} from "@/lib/server/payment/status";
import { logError } from "@/lib/server/alerts/log-error";
import { paymentFailed } from "@/lib/server/payment/response";
import { getStationConfigByCode } from "@/lib/server/station-config";

type PaymentRequestBody = {
  phone?: string;
  phoneNumber?: string;
  amount?: number;
  stationCode?: string;
};

function parseAndValidateBody(body: PaymentRequestBody) {
  const rawPhone =
    typeof body.phone === "string"
      ? body.phone
      : typeof body.phoneNumber === "string"
        ? body.phoneNumber
        : "";

  const phoneDigits = rawPhone.replace(/\D/g, "");
  const localPhone = phoneDigits.startsWith("252")
    ? phoneDigits.slice(3)
    : phoneDigits;
  const phone = `+252${localPhone}`;
  const amount = Number(body.amount);
  const stationCode = typeof body.stationCode === "string"
    ? body.stationCode.trim()
    : "";

  if (!/^\+252\d{9}$/.test(phone) || Number.isNaN(amount) || amount <= 0) {
    return {
      error: "Missing valid phone and amount",
    } as const;
  }

  if (stationCode) {
    const config = getStationConfigByCode(stationCode);
    if (!config) {
      return {
        error: "Invalid station code",
      } as const;
    }
  }

  return {
    phone,
    amount,
    stationCode,
  } as const;
}

export async function POST(request: NextRequest) {
  let body: PaymentRequestBody;
  let transactionId: string | null = null;

  try {
    body = (await request.json()) as PaymentRequestBody;
  } catch {
    return paymentFailed(
      {
        status: "failed",
        stage: "system",
        reason_code: "INVALID_REQUEST",
        error: "Invalid JSON body",
        fault: "system",
      },
      400,
    );
  }

  const parsed = parseAndValidateBody(body);

  if ("error" in parsed) {
    return paymentFailed(
      {
        status: "failed",
        stage: "precheck",
        reason_code: "INVALID_REQUEST",
        error: parsed.error || "Missing valid phone and amount",
        fault: "user",
      },
      400,
    );
  }

  // Phase 6: Station Health Entry Gate (Critical Invariant Enforcement)
  if (parsed.stationCode) {
    const healthy = await isStationHealthy(parsed.stationCode);
    if (!healthy) {
      await logError({
        type: "PAYMENT_GUARD_BLOCK",
        message: "Payment blocked by backend station health gate",
        metadata: {
          stage: "precheck",
          reason_code: "STATION_OFFLINE",
          stationCode: parsed.stationCode,
        },
      });
      return paymentFailed(
        {
          status: "failed",
          stage: "precheck",
          reason_code: "STATION_OFFLINE",
          error: "This station is currently unavailable. Please try another station.",
          fault: "system",
        },
        409,
      );
    }
  }

  try {
    const transaction = await createMinimalTransaction({
      phone: parsed.phone,
      amount: parsed.amount,
      station: parsed.stationCode || undefined,
    });
    transactionId = transaction.id;

    await logTransactionEvent(transaction.id, "PAYMENT_INITIATED", {
      phone: parsed.phone,
      amount: parsed.amount,
    }, "IMPORTANT");

    await logTransactionEvent(transaction.id, "WAAFI_PREAUTH_REQUEST", {
      phone: parsed.phone,
      amount: parsed.amount,
    }, "IMPORTANT");

    const providerResponse = await requestWaafiPreauthorization({
      phoneNumber: parsed.phone.replace(/\D/g, ""),
      amount: parsed.amount,
      referenceId: transaction.id,
    });
    const providerIds = extractWaafiIds(providerResponse);

    await logTransactionEvent(transaction.id, "WAAFI_PREAUTH_RESPONSE", {
      phone: parsed.phone,
      amount: parsed.amount,
      providerResponse,
      providerRef: providerIds.transactionId || null,
      hasTransactionId: !!providerIds.transactionId,
    }, "IMPORTANT");

    const failureReason = detectFailureReason(providerResponse);
    const hasStrongFailureSignal =
      failureReason === "USER_CANCELLED" ||
      failureReason === "INSUFFICIENT_FUNDS" ||
      failureReason === "PROVIDER_DECLINED";

    const indicatesHold =
      providerResponse?.responseCode === 2001 ||
      providerResponse?.params?.state === "APPROVED" ||
      providerResponse?.params?.state === "FORAPPROVAL";

    const hasTransactionId = !!providerIds.transactionId;

    if (indicatesHold && hasTransactionId) {
      await patchPhase2Transaction({
        id: transaction.id,
        patch: {
          status: "held",
          providerRef: providerIds.transactionId,
          heldAt: Date.now(),
          unlockStarted: false,
        },
      });

      // Eagerly acquire delivery context if we have a stationCode
      if (parsed.stationCode) {
        const delivery = await ensureDeliveryContext({
          id: transaction.id,
          station: parsed.stationCode,
          phone: parsed.phone,
          status: "held",
        });

        // Immediate Execution Contract: Trigger unlock right away
        if (delivery) {
          await triggerUnlockIfNeeded(transaction.id);
        }
      }

      await logTransactionEvent(transaction.id, "PROVIDER_HOLD_DETECTED", {
        phone: parsed.phone,
        amount: parsed.amount,
        providerRef: providerIds.transactionId,
      }, "CRITICAL");

      return NextResponse.json({
        transactionId: transaction.id,
        status: "held",
      });
    }

    if (!hasTransactionId) {
      if (hasStrongFailureSignal) {
        console.log("EXPLICIT_FAILURE_DETECTED:", {
          transactionId: transaction.id,
          failureReason,
        });

        await logTransactionEvent(transaction.id, "EXPLICIT_FAILURE_DETECTED", {
          phone: parsed.phone,
          amount: parsed.amount,
          response: providerResponse,
        }, "CRITICAL");

        await patchPhase2Transaction({
          id: transaction.id,
          patch: {
            status: "failed",
            failureReason,
          },
        });

        await logError({
          type: "PAYMENT_FAILED",
          transactionId: transaction.id,
          message: "Provider explicit payment failure",
          metadata: {
            stage: "payment",
            reason_code: failureReason,
            fault:
              failureReason === "INSUFFICIENT_FUNDS" || failureReason === "USER_CANCELLED"
                ? "user"
                : "system",
          },
        });

        return paymentFailed(
          {
            status: "failed",
            reason_code: failureReason,
            stage: "payment",
            fault:
              failureReason === "INSUFFICIENT_FUNDS" || failureReason === "USER_CANCELLED"
                ? "user"
                : "system",
            error:
              failureReason === "INSUFFICIENT_FUNDS"
                ? "Insufficient balance"
                : failureReason === "PROVIDER_DECLINED"
                  ? "Payment declined"
                  : "Payment cancelled by user",
          },
          409,
        );
      }

      if (indicatesHold) {
        console.error("HOLD_WITHOUT_TRANSACTION_ID", {
          providerResponse,
          transactionId: transaction.id,
        });

        await logTransactionEvent(transaction.id, "UNCERTAIN_HOLD_DETECTED", {
          phone: parsed.phone,
          amount: parsed.amount,
          message: "Hold indicated but transactionId missing",
          response: providerResponse,
        }, "CRITICAL");

        await logError({
          type: "PROVIDER_MISSING_REF",
          transactionId: transaction.id,
          message: "Hold likely created but transactionId missing",
          metadata: providerResponse,
        });

        await patchPhase2Transaction({
          id: transaction.id,
          patch: {
            status: "pending_payment",
            missingProviderRef: true,
          },
        });

        return NextResponse.json({
          transactionId: transaction.id,
          status: "pending_payment",
        });
      }

      // True unknown -> safe fail
      console.error("UNKNOWN_PREAUTH_STATE_FAILING_SAFE", {
        providerResponse,
        transactionId: transaction.id,
      });

      await logTransactionEvent(transaction.id, "UNKNOWN_PREAUTH_STATE_FAILURE", {
        phone: parsed.phone,
        amount: parsed.amount,
        response: providerResponse,
      });

      await logError({
        type: "PROVIDER_INCONSISTENT_RESPONSE",
        transactionId: transaction.id,
        message: "Waafi response indicates success/uncertainty but missing transactionId and no hold state",
        metadata: providerResponse,
      });

      await patchPhase2Transaction({
        id: transaction.id,
        patch: {
          status: "failed",
          failureReason: "PROVIDER_ERROR",
        },
      });

      return paymentFailed(
        {
          status: "failed",
          reason_code: "PROVIDER_ERROR",
          stage: "payment",
          error: "Payment provider error",
          fault: "system",
        },
        502,
      );
    }

    // hasTransactionId exists
    await patchPhase2Transaction({
      id: transaction.id,
      patch: {
        providerRef: providerIds.transactionId,
        status: "pending_payment",
      },
    });

    await logTransactionEvent(transaction.id, "PAYMENT_AWAITING_PIN", {
      phone: parsed.phone,
      amount: parsed.amount,
      providerRef: providerIds.transactionId,
    });

    return NextResponse.json({
      transactionId: transaction.id,
      status: "pending_payment",
    });
  } catch (error) {
    console.error("WAAFI_PREAUTH_EXCEPTION", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (transactionId) {
      await patchPhase2Transaction({
        id: transactionId,
        patch: {
          status: "failed",
          failureReason: "PROVIDER_ERROR",
          failureStage: "payment",
          lastProviderError: errorMessage,
        },
      });

      await logTransactionEvent(transactionId, "WAAFI_PREAUTH_EXCEPTION", {
        phone: parsed.phone,
        amount: parsed.amount,
        error: errorMessage,
      }, "CRITICAL");
    }

    // logError is async but we don't necessarily need to await it before returning 502, 
    // though it's safer to ensure it finishes.
    await logError({
      type: "PROVIDER_REQUEST_FAILED",
      transactionId: transactionId || undefined,
      message: "Exception during Waafi preauth request",
      metadata: {
        error: errorMessage,
        phone: parsed.phone,
        amount: parsed.amount
      }
    });

    return paymentFailed(
      {
        status: "failed",
        reason_code: "PROVIDER_ERROR",
        stage: "payment",
        error: "Payment provider error",
        fault: "system",
      },
      502,
    );
  }
}
