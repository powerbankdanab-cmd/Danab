import { NextRequest, NextResponse } from "next/server";

import { isHttpError } from "@/lib/server/payment/errors";
import { getProviderDrivenPaymentStatus } from "@/lib/server/payment/status";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const transactionId = searchParams.get("transactionId");

    if (!transactionId) {
      return NextResponse.json({ error: "Missing transactionId" }, { status: 400 });
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
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("Payment status endpoint error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
