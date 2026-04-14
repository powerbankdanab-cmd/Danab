import { NextRequest, NextResponse } from "next/server";

import { isHttpError, processPayment } from "@/lib/server/payment-service";

import { checkRateLimit } from "@/lib/server/rate-limit";

import { getClientIp } from "@/lib/server/request";

type PaymentRequestBody = {
  phoneNumber?: string;

  amount?: number;
  stationCode?: string;
};

function parseAndValidateBody(body: PaymentRequestBody) {
  const phoneNumber =
    typeof body.phoneNumber === "string"
      ? body.phoneNumber.replace(/\D/g, "")
      : "";

  const amount = Number(body.amount);
  const stationCode =
    typeof body.stationCode === "string"
      ? body.stationCode.replace(/\D/g, "")
      : "";

  if (!phoneNumber || Number.isNaN(amount) || amount <= 0) {
    return { error: "Missing phoneNumber or valid amount" } as const;
  }

  return {
    phoneNumber,
    amount,
    ...(stationCode ? { stationCode } : {}),
  } as const;
}

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const clientIp = getClientIp(request);

  const rateLimitResult = checkRateLimit(`payment:${clientIp}`, {
    windowMs: 5 * 60_000,

    max: 10,
  });

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: "Too many payment requests, please try again later." },

      {
        status: 429,

        headers: {
          "Retry-After": String(rateLimitResult.retryAfterSeconds),
        },
      },
    );
  }

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
    const result = await processPayment(parsed);

    return NextResponse.json(result);
  } catch (error) {
    if (isHttpError(error)) {
      const payload = error.details
        ? {
            error: error.message,

            ...(error.details as Record<string, unknown>),
          }
        : { error: error.message };

      return NextResponse.json(payload, { status: error.status });
    }

    const message =
      error instanceof Error ? error.message : "Internal server error";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
