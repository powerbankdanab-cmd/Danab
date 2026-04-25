import { NextRequest, NextResponse } from "next/server";

import {
  createMinimalTransaction,
  patchPhase2Transaction,
} from "@/lib/server/payment/transactions";
import {
  classifyWaafiPaymentStatus,
  extractWaafiIds,
  requestWaafiPreauthorization,
} from "@/lib/server/payment/waafi";

type PaymentRequestBody = {
  phone?: string;
  phoneNumber?: string;
  amount?: number;
};

function failedPaymentResponse(
  reason: "USER_CANCELLED" | "PROVIDER_ERROR",
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

function looksUserCancelled(value: unknown) {
  const text = String(value || "").toLowerCase();
  return (
    text.includes("cancel") ||
    text.includes("dismiss") ||
    text.includes("abandon") ||
    text.includes("abort") ||
    text.includes("closed by user") ||
    text.includes("closed") ||
    text.includes("decline") ||
    text.includes("revers") ||
    text.includes("user")
  );
}

function looksLikeWaafiUserCancelled(response: unknown) {
  const payload = response as {
    params?: Record<string, unknown>;
    responseMsg?: unknown;
    message?: unknown;
    errorCode?: unknown;
    error?: unknown;
  };

  const state = String(payload.params?.state || "").toLowerCase();
  const message = String(payload.responseMsg || payload.message || "").toLowerCase();
  const error = String(payload.errorCode || payload.error || "").toLowerCase();

  return (
    state.includes("cancel") ||
    state.includes("abort") ||
    state.includes("decline") ||
    message.includes("cancel") ||
    message.includes("user") ||
    message.includes("abort") ||
    message.includes("dismiss") ||
    message.includes("closed") ||
    message.includes("decline") ||
    error.includes("cancel") ||
    error.includes("user") ||
    error.includes("abort")
  );
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
    console.log("WAAFI PREAUTH RAW:", providerResponse);
    const providerStatus = classifyWaafiPaymentStatus(providerResponse);

    console.info("payment_request_sent", {
      phone: parsed.phone,
      transactionId: transaction.id,
      providerRef: providerIds.transactionId || null,
      providerStatus,
      providerResponseCode:
        providerResponse.responseCode !== undefined
          ? String(providerResponse.responseCode)
          : null,
      providerErrorCode: providerResponse.errorCode || null,
      providerState: providerResponse.params?.state || null,
    });

    if (!providerIds.transactionId) {
      const responseCode = String(providerResponse.responseCode || "").trim();
      const responseState = String(providerResponse.params?.state || "").toUpperCase();
      const isApproved = responseCode === "2001" && responseState === "APPROVED";
      const looksCancelled =
        providerStatus === "cancelled" || looksLikeWaafiUserCancelled(providerResponse);

      const failureReason: "USER_CANCELLED" | "PROVIDER_ERROR" =
        !isApproved ? "USER_CANCELLED" : looksCancelled ? "USER_CANCELLED" : "PROVIDER_ERROR";

      console.log("NO PROVIDER REF CASE:", {
        response: providerResponse,
        classifiedAs: failureReason,
      });

      await patchPhase2Transaction({
        id: transaction.id,
        patch: {
          status: "failed",
          failureReason,
        },
      });

      console.info("payment_failed", {
        transactionId: transaction.id,
        failureReason,
      });

      return NextResponse.json(
        failureReason === "USER_CANCELLED"
          ? {
            status: "failed",
            reason_code: "USER_CANCELLED",
            failureReason: "USER_CANCELLED",
            error: "Payment cancelled by user",
          }
          : {
            status: "failed",
            reason_code: "PROVIDER_ERROR",
            failureReason: "PROVIDER_ERROR",
            error: "Payment provider did not return a transaction id",
          },
        { status: failureReason === "USER_CANCELLED" ? 409 : 502 },
      );
    }

    await patchPhase2Transaction({
      id: transaction.id,
      patch: {
        providerRef: providerIds.transactionId,
        status: "pending_payment",
      },
    });

    return NextResponse.json({
      transactionId: transaction.id,
      status: transaction.record.status,
      providerRef: providerIds.transactionId,
    });
  } catch (error) {
    const msg = String((error as { message?: unknown })?.message || "").toLowerCase();
    const userCancelled =
      msg.includes("cancel") ||
      msg.includes("user") ||
      msg.includes("abort") ||
      msg.includes("dismiss") ||
      msg.includes("closed") ||
      msg.includes("decline");

    console.log("WAAFI PREAUTH ERROR:", error);

    console.info("provider_error", {
      stage: "payment_request_sent",
      error: msg,
    });

    return NextResponse.json(
      userCancelled
        ? {
          status: "failed",
          reason_code: "USER_CANCELLED",
          failureReason: "USER_CANCELLED",
          error: "Payment cancelled by user",
        }
        : {
          status: "failed",
          reason_code: "PROVIDER_ERROR",
          failureReason: "PROVIDER_ERROR",
          error: "Payment provider error",
        },
      { status: userCancelled ? 409 : 500 },
    );
  }
}
