import { NextRequest, NextResponse } from "next/server";
import { logError, CRITICAL_ERROR_TYPES } from "@/lib/server/alerts/log-error";

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return new Response("Disabled in production", { status: 403 });
  }

  const token = request.headers.get("x-internal-key");
  if (!token || token !== process.env.INTERNAL_ALERT_TEST_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }
  const transactionId = `test-${Date.now()}`;
  
  const results = [];
  
  // 1. Test standard verification failure alert
  results.push(await logError({
    type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
    transactionId,
    stationCode: "TEST-01",
    phoneNumber: "252611234567",
    message: "TEST: Ejection verification failed during simulated test."
  }));

  // 2. Test duplicate deduplication right after
  results.push(await logError({
    type: CRITICAL_ERROR_TYPES.VERIFICATION_FAILED,
    transactionId,
    stationCode: "TEST-01",
    phoneNumber: "252611234567",
    message: "TEST: This should be deduplicated and ENQUEUED due to rate limiting or dedup skip!"
  }));

  // 3. Test station failure triggers (requires 5 failures in 10 mins).
  // We trigger it 5 times:
  for(let i=0; i<5; i++) {
    await logError({
      type: "MINOR_WARNING_NOT_CRITICAL_BUT_STATION_FAILS",
      transactionId: `test-station-${i}`,
      stationCode: "TEST-BROKEN-STATION",
      message: `TEST: Minor failure ${i}`
    });
  }

  // 4. Test system inconsistency
  results.push(await logError({
    type: CRITICAL_ERROR_TYPES.SYSTEM_INCONSISTENCY,
    transactionId: `test-sys-${Date.now()}`,
    stationCode: "TEST-SYS",
    message: "TEST: Post-capture DB error!"
  }));

  return NextResponse.json({
    success: true,
    message: "Check your WhatsApp device, Firestore 'errors' collection, and Firestore 'alerts_queue' collection.",
    results
  });
}
