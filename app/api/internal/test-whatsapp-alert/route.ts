import { NextRequest, NextResponse } from "next/server";

import { validateInternalTestAccess } from "@/lib/server/alerts/internal-test-guard";
import {
  getWhatsAppAlertRateLimitState,
  sendWhatsAppAlertWithResult,
} from "@/lib/server/alerts/whatsapp";

export async function GET(request: NextRequest) {
  const auth = validateInternalTestAccess(request);
  if (!auth.allowed) {
    const payload = { success: false, error: auth.error } as Record<string, unknown>;
    if ("retryAfterSeconds" in auth) {
      payload.retryAfterSeconds = auth.retryAfterSeconds;
    }
    return NextResponse.json(payload, { status: auth.status });
  }

  const result = await sendWhatsAppAlertWithResult(
    `DANAB TEST ALERT\nTime: ${new Date().toISOString()}\nStatus: WhatsApp integration working`,
  );

  return NextResponse.json({
    success: true,
    result,
    rateLimit: getWhatsAppAlertRateLimitState(),
  });
}
