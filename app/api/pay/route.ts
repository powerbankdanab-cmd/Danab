import { NextRequest, NextResponse } from "next/server";

import {
  createMinimalTransaction,
  patchPhase2Transaction,
} from "@/lib/server/payment/transactions";
import {
  classifyWaafiPaymentStatus,
  extractWaafiIds,
  requestWaafiPreauthorization,
  detectFailureReason,
} from "@/lib/server/payment/waafi";
import { logError } from "@/lib/server/alerts/log-error";

type PaymentRequestBody = {
  phone?: string;
  phoneNumber?: string;
  amount?: number;
};

function failedPaymentResponse(
  reason:
    | "USER_CANCELLED"
    | "INSUFFICIENT_FUNDS"
    | "PROVIDER_DECLINED"
    | "PROVIDER_ERROR",
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

  if (!/^\+252\d{9}$/.test(phone) || Number.isNaN(amount) || amount <= 0) {
    return {
      error: "Missing valid phone and amount",
    } as const;
  }

  return {
    phone,
    amount,
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

  try {
    const transaction = await createMinimalTransaction(parsed);
    const providerResponse = await requestWaafiPreauthorization({
      phoneNumber: parsed.phone.replace(/\D/g, ""),
      amount: parsed.amount,
      referenceId: transaction.id,
    });
    const providerIds = extractWaafiIds(providerResponse);

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

    if (!hasTransactionId) {
      if (hasStrongFailureSignal) {
        console.log("EXPLICIT_FAILURE_DETECTED:", {
          transactionId: transaction.id,
          failureReason,
        });

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
