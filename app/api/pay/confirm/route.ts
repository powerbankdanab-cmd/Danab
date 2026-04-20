import { NextRequest, NextResponse } from "next/server";
import { handleUserConfirmation, isHttpError } from "@/lib/server/payment-service";
import { logError } from "@/lib/server/alerts/log-error";

export async function POST(request: NextRequest) {
  try {
    const { transactionId, confirmed } = await request.json();

    if (!transactionId) {
      return NextResponse.json(
        { error: "Missing transactionId" },
        { status: 400 }
      );
    }

    const result = await handleUserConfirmation(transactionId, !!confirmed);
    return NextResponse.json(result);
  } catch (error) {
    if (isHttpError(error)) {
      const payload = { error: error.message };
      if (error.details && typeof error.details === "object") {
        Object.assign(payload, error.details);
      }
      return NextResponse.json(payload, { status: error.status });
    }

    await logError({
      type: "SYSTEM_INCONSISTENCY",
      message: "Uncaught error in payment confirmation API",
      metadata: { error: String(error) }
    });

    return NextResponse.json(
      { error: "Internal server error during confirmation" },
      { status: 500 }
    );
  }
}
