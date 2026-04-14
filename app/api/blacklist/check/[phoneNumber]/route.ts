import { NextRequest, NextResponse } from "next/server";

import { isPhoneBlacklisted } from "@/lib/server/payment-service";
import { getClientIp } from "@/lib/server/request";
import { checkRateLimit } from "@/lib/server/rate-limit";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ phoneNumber: string }> },
) {
  const { phoneNumber } = await context.params;

  if (!phoneNumber) {
    return NextResponse.json({ error: "Phone number is required" }, { status: 400 });
  }

  const clientIp = getClientIp(request);
  const rateLimitResult = checkRateLimit(`blacklist:${clientIp}`, {
    windowMs: 60_000,
    max: 20,
  });

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: "Too many requests, please slow down." },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimitResult.retryAfterSeconds),
        },
      },
    );
  }

  try {
    const blacklisted = await isPhoneBlacklisted(phoneNumber);
    return NextResponse.json({ blacklisted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to check blacklist status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
