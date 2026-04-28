import { NextRequest, NextResponse } from "next/server";

import { queryStationBatteries, MIN_AVAILABLE_BATTERY_PERCENT } from "@/lib/server/payment/heycharge";
import { getStationConfigByCode } from "@/lib/server/station-config";

type PrecheckRequestBody = {
  stationCode?: string;
};

function failed(stage: "precheck" | "system", reason_code: string, error: string, status = 400) {
  return NextResponse.json(
    {
      status: "failed",
      stage,
      reason_code,
      error,
    },
    { status },
  );
}

export async function POST(request: NextRequest) {
  let body: PrecheckRequestBody;
  try {
    body = (await request.json()) as PrecheckRequestBody;
  } catch {
    return failed("system", "INVALID_REQUEST", "Invalid JSON body", 400);
  }

  const stationCode = String(body.stationCode || "").trim();
  if (!stationCode) {
    return failed("precheck", "INVALID_STATION", "Missing station code", 400);
  }

  const config = getStationConfigByCode(stationCode);
  if (!config) {
    return failed("precheck", "INVALID_STATION", "Invalid station code", 400);
  }

  let batteries;
  try {
    batteries = await queryStationBatteries(config.imei);
  } catch {
    return failed("precheck", "STATION_OFFLINE", "Station-kan ma shaqeynayo", 409);
  }

  if (!Array.isArray(batteries) || batteries.length === 0) {
    return failed("precheck", "NO_BATTERIES", "Ma jiro battery diyaar ah", 409);
  }

  const hasAboveThreshold = batteries.some((battery) => {
    const capacity = Number.parseInt(String(battery.battery_capacity || "0"), 10);
    return Number.isFinite(capacity) && capacity >= MIN_AVAILABLE_BATTERY_PERCENT;
  });

  if (!hasAboveThreshold) {
    return failed("precheck", "LOW_BATTERY", "Battery-yadu wali way dallacayaan", 409);
  }

  return NextResponse.json({
    status: "ok",
    stage: "precheck",
  });
}
