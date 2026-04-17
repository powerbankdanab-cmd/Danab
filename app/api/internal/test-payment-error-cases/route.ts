import { NextRequest, NextResponse } from "next/server";

import { CRITICAL_ERROR_TYPES, logError } from "@/lib/server/alerts/log-error";

export async function GET(request: NextRequest) {
  const scenario = String(
    request.nextUrl.searchParams.get("case") || "",
  ).toLowerCase();

  if (scenario === "verification_failed") {
    await logError({
      type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
      transactionId: "sim-tx-verification-failed",
      stationCode: "SIM-58",
      phoneNumber: "252611111111",
      message: "Simulated battery not ejected after unlock attempts",
      metadata: {
        scenario: "force_battery_not_eject",
      },
    });

    return NextResponse.json({
      success: true,
      simulatedCase: "Force battery not eject",
      type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
    });
  }

  if (scenario === "capture_unknown") {
    await logError({
      type: CRITICAL_ERROR_TYPES.CAPTURE_UNKNOWN,
      transactionId: "sim-tx-capture-unknown",
      stationCode: "SIM-59",
      phoneNumber: "252622222222",
      message: "Simulated payment commit timeout / ambiguity",
      metadata: {
        scenario: "simulate_capture_timeout",
      },
    });

    return NextResponse.json({
      success: true,
      simulatedCase: "Simulate capture timeout",
      type: CRITICAL_ERROR_TYPES.CAPTURE_UNKNOWN,
    });
  }

  return NextResponse.json(
    {
      success: false,
      error:
        "Unknown case. Use ?case=verification_failed or ?case=capture_unknown",
    },
    { status: 400 },
  );
}

