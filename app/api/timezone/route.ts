import { NextResponse } from "next/server";

export async function GET() {
  const now = new Date();

  return NextResponse.json({
    serverTime: now.toISOString(),
    serverTimeLocal: now.toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: now.getTimezoneOffset(),
    offsetHours: -now.getTimezoneOffset() / 60,
  });
}
