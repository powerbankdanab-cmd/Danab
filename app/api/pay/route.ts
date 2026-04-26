import { NextRequest, NextResponse } from "next/server";

import {
  createMinimalTransaction,
  patchPhase2Transaction,
  logTransactionEvent,
  getPaymentTransaction,
} from "@/lib/server/payment/transactions";
import {
  classifyWaafiPaymentStatus,
  extractWaafiIds,
  requestWaafiPreauthorization,
  detectFailureReason,
} from "@/lib/server/payment/waafi";
import { ensureDeliveryContext, triggerUnlockIfNeeded } from "@/lib/server/payment/status";
import { logError } from "@/lib/server/alerts/log-error";
import { checkUserRestrictions } from "@/lib/server/payment/rentals";
import { getStationConfigByCode } from "@/lib/server/station-config";

type PaymentRequestBody = {
  phone?: string;
  phoneNumber?: string;
  amount?: number;
  stationCode?: string;
};

function failedPaymentResponse(
  reason:
    | "USER_CANCELLED"
    | "INSUFFICIENT_FUNDS"
    | "PROVIDER_DECLINED"
    | "PROVIDER_ERROR"
    | "ACTIVE_RENTAL_OVERDUE"
    | "ACTIVE_RENTAL_LOST",
  error: string,
  status: number,
) {
  return NextResponse.json(
    {
      status: "failed",
      reason_code: reason,
      failureReason: reason,
      error,
    },
    { status },
  );
}

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

  try {
    body = (await request.json()) as PaymentRequestBody;
  } catch {
    return failedPaymentResponse("PROVIDER_ERROR", "Invalid JSON body", 400);
  }

  const parsed = parseAndValidateBody(body);

  if ("error" in parsed) {
    return failedPaymentResponse(
      "PROVIDER_ERROR",
      parsed.error || "Missing valid phone and amount",
      400,
    );
  }

  const restriction = await checkUserRestrictions(parsed.phone);
  if (restriction.restricted) {
    return failedPaymentResponse(
      restriction.reason!,
      restriction.reason === "ACTIVE_RENTAL_OVERDUE"
        ? "You have an overdue battery. Please return it before renting again."
        : "Your account is blocked due to a lost battery. Please contact support.",
      403,
    );
  }

  try {
    const transaction = await createMinimalTransaction({
      phone: parsed.phone,
      amount: parsed.amount,
      station: parsed.stationCode || undefined,
    });

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
          const refreshed = await getPaymentTransaction(transaction.id);
          if (refreshed) {
            await triggerUnlockIfNeeded(refreshed);
          }
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

        return NextResponse.json(
          {
            status: "failed",
            reason_code: failureReason,
            failureReason,
            error:
              failureReason === "INSUFFICIENT_FUNDS"
                ? "Insufficient balance"
                : failureReason === "PROVIDER_DECLINED"
                  ? "Payment declined"
                  : "Payment cancelled by user",
          },
          { status: 409 },
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

      return NextResponse.json(
        {
          status: "failed",
          reason_code: "PROVIDER_ERROR",
          failureReason: "PROVIDER_ERROR",
          error: "Payment provider error",
        },
        { status: 502 },
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

    // logError is async but we don't necessarily need to await it before returning 502, 
    // though it's safer to ensure it finishes.
    await logError({
      type: "PROVIDER_REQUEST_FAILED",
      message: "Exception during Waafi preauth request",
      metadata: {
        error: error instanceof Error ? error.message : String(error),
        phone: parsed.phone,
        amount: parsed.amount
      }
    });

    return NextResponse.json(
      {
        status: "failed",
        reason_code: "PROVIDER_ERROR",
        failureReason: "PROVIDER_ERROR",
        error: "Payment provider error",
      },
      { status: 502 },
    );
  }
}
