import { NextRequest, NextResponse } from "next/server";

import { getOptionalEnv } from "@/lib/server/env";
import { reconcileTransactions } from "@/lib/server/payment/reconciliation";

export const maxDuration = 300;

function isAuthorized(request: NextRequest) {
  const secret = getOptionalEnv("RECONCILE_CRON_SECRET");
  if (!secret) {
    return true;
  }

  const authHeader = request.headers.get("authorization") || "";
  return authHeader === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limitRaw = Number(request.nextUrl.searchParams.get("limit") || "50");
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(200, Math.trunc(limitRaw)))
    : 50;

  const result = await reconcileTransactions(limit);
  return NextResponse.json(result);
}

