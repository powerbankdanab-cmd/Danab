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
    text.includes("closed by user")
  );
}

export async function POST(request: NextRequest) {
  let body: PaymentRequestBody;

  try {
    body = (await request.json()) as PaymentRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseAndValidateBody(body);

  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const transaction = await createMinimalTransaction(parsed);
    const providerResponse = await requestWaafiPreauthorization({
      phoneNumber: parsed.phone.replace(/\D/g, ""),
      amount: parsed.amount,
      referenceId: transaction.id,
    });
    const providerIds = extractWaafiIds(providerResponse);
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
      const failureReason =
        providerStatus === "cancelled" ? "USER_CANCELLED" : "PROVIDER_REF_MISSING";

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
            error: "Payment cancelled by user",
          }
          : { error: "Payment provider did not return a transaction id" },
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const userCancelled = looksUserCancelled(message);

    console.info("provider_error", {
      stage: "payment_request_sent",
      error: message,
    });

    return NextResponse.json(
      userCancelled
        ? {
          status: "failed",
          reason_code: "USER_CANCELLED",
          error: "Payment cancelled by user",
        }
        : { error: "Failed to create transaction" },
      { status: userCancelled ? 409 : 500 },
    );
  }
}
