import { NextRequest, NextResponse } from "next/server";

import { isHttpError } from "@/lib/server/payment/errors";
import { paymentFailed } from "@/lib/server/payment/response";
import { getProviderDrivenPaymentStatus } from "@/lib/server/payment/status";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const transactionId = searchParams.get("transactionId");

    if (!transactionId) {
      return paymentFailed(
        {
          status: "failed",
          stage: "system",
          reason_code: "INVALID_REQUEST",
          error: "Missing transactionId",
          fault: "user",
        },
        400,
      );
    }

    const payload = await getProviderDrivenPaymentStatus(transactionId);
    return NextResponse.json(payload);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "digest" in error &&
      (error as { digest?: string }).digest === "NEXT_PRERENDER_INTERRUPTED"
    ) {
      throw error;
    }

    if (isHttpError(error)) {
      return paymentFailed(
        {
          status: "failed",
          stage: "system",
          reason_code: "PROVIDER_ERROR",
          error: error.message,
          fault: "system",
        },
        error.status,
      );
    }

    console.error("Payment status endpoint error:", error);
    return paymentFailed(
      {
        status: "failed",
        stage: "system",
        reason_code: "PROVIDER_ERROR",
        error: "Internal server error",
        fault: "system",
      },
      500,
    );
  }
}
