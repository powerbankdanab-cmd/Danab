import { NextRequest, NextResponse } from "next/server";

import {
  createMinimalTransaction,
  patchPhase2Transaction,
} from "@/lib/server/payment/transactions";
import {
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

    console.info("payment_request_sent", {
      phone: parsed.phone,
      transactionId: transaction.id,
      providerRef: providerIds.transactionId || null,
      providerResponseCode:
        providerResponse.responseCode !== undefined
          ? String(providerResponse.responseCode)
          : null,
      providerErrorCode: providerResponse.errorCode || null,
      providerState: providerResponse.params?.state || null,
    });

    if (!providerIds.transactionId) {
      await patchPhase2Transaction({
        id: transaction.id,
        patch: {
          status: "failed",
          failureReason: "PROVIDER_REF_MISSING",
        },
      });

      console.info("payment_failed", {
        transactionId: transaction.id,
        failureReason: "PROVIDER_REF_MISSING",
      });

      return NextResponse.json(
        { error: "Payment provider did not return a transaction id" },
        { status: 502 },
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
    console.info("provider_error", {
      stage: "payment_request_sent",
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      { error: "Failed to create transaction" },
      { status: 500 },
    );
  }
}
