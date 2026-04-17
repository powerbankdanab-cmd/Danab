import { NextRequest } from "next/server";

import { getOptionalEnv } from "@/lib/server/env";
import { checkRateLimit } from "@/lib/server/rate-limit";
import { getClientIp } from "@/lib/server/request";

export function validateInternalTestAccess(request: NextRequest) {
  const configuredToken = getOptionalEnv("INTERNAL_ALERT_TEST_TOKEN");

  if (!configuredToken) {
    return {
      allowed: false,
      status: 503,
      error:
        "Missing INTERNAL_ALERT_TEST_TOKEN in environment; internal test endpoints are locked.",
    } as const;
  }

  const bearer = request.headers.get("authorization") || "";
  const headerToken = request.headers.get("x-internal-token") || "";
  const providedToken =
    bearer.startsWith("Bearer ") && bearer.length > 7
      ? bearer.slice(7).trim()
      : headerToken.trim();

  if (!providedToken || providedToken !== configuredToken) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized internal test request.",
    } as const;
  }

  const clientIp = getClientIp(request);
  const rate = checkRateLimit(`internal-test-alert:${clientIp}`, {
    windowMs: 60_000,
    max: 10,
  });

  if (!rate.allowed) {
    return {
      allowed: false,
      status: 429,
      error: "Too many internal test requests. Please wait.",
      retryAfterSeconds: rate.retryAfterSeconds,
    } as const;
  }

  return {
    allowed: true,
  } as const;
}

