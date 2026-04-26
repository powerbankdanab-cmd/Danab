import { NextRequest, NextResponse } from "next/server";

import { getOptionalEnv } from "@/lib/server/env";
import { auditCaptureInvariants } from "@/lib/server/payment/reconciliation";

export const maxDuration = 60;

function isAuthorized(request: NextRequest) {
  const secret = getOptionalEnv("INTERNAL_CRON_TOKEN") || getOptionalEnv("RECONCILE_CRON_SECRET");
  if (!secret) {
    return true; // For local dev without secret
  }

  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization") || "";
  return authHeader === `Bearer ${secret}`;
}

/**
 * Phase 4 Hardening: Capture invariant audit endpoint.
 *
 * Designed to run on a periodic cron (hourly/daily).
 * Scans for impossible states and logs violations for alerting.
 *
 * Does NOT auto-repair — use reconcile-payments or reconcile-transactions for that.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limitRaw = Number(request.nextUrl.searchParams.get("limit") || "100");
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(500, Math.trunc(limitRaw)))
    : 100;

  const result = await auditCaptureInvariants(limit);
  return NextResponse.json(result);
}
