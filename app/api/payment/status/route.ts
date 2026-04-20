import { NextRequest, NextResponse } from "next/server";

import { getProviderDrivenPaymentStatus } from "@/lib/server/payment/status";
import { isHttpError } from "@/lib/server/payment-service";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const transactionId = searchParams.get("transactionId");

    if (!transactionId) {
      return NextResponse.json({ error: "Missing transactionId" }, { status: 400 });
    }

    const payload = await getProviderDrivenPaymentStatus(transactionId);
    return NextResponse.json(payload);
  } catch (error) {
    if (isHttpError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("Payment status endpoint error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
