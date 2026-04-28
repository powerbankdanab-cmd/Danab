import { NextRequest, NextResponse } from "next/server";

import { queryStationBatteries, MIN_AVAILABLE_BATTERY_PERCENT } from "@/lib/server/payment/heycharge";
import { logError } from "@/lib/server/alerts/log-error";
import { paymentFailed } from "@/lib/server/payment/response";
import { getStationConfigByCode } from "@/lib/server/station-config";

type PrecheckRequestBody = {
  stationCode?: string;
};

export async function POST(request: NextRequest) {
  let body: PrecheckRequestBody;
  try {
    body = (await request.json()) as PrecheckRequestBody;
  } catch {
    return paymentFailed(
      {
        status: "failed",
        stage: "system",
        reason_code: "INVALID_REQUEST",
        error: "Invalid JSON body",
        fault: "system",
      },
      400,
    );
  }

  const stationCode = String(body.stationCode || "").trim();
  if (!stationCode) {
    return paymentFailed(
      {
        status: "failed",
        stage: "precheck",
        reason_code: "INVALID_STATION",
        error: "Missing station code",
        fault: "user",
      },
      400,
    );
  }

  const config = getStationConfigByCode(stationCode);
  if (!config) {
    return paymentFailed(
      {
        status: "failed",
        stage: "precheck",
        reason_code: "INVALID_STATION",
        error: "Invalid station code",
        fault: "user",
      },
      400,
    );
  }

  let batteries;
  try {
    batteries = await queryStationBatteries(config.imei);
  } catch {
    await logError({
      type: "PRECHECK_FAILED",
      message: "Precheck failed: station offline",
      metadata: { stage: "precheck", reason_code: "STATION_OFFLINE", stationCode, imei: config.imei },
    });
    return paymentFailed(
      {
        status: "failed",
        stage: "precheck",
        reason_code: "STATION_OFFLINE",
        error: "Station-kan ma shaqeynayo",
        fault: "system",
      },
      409,
    );
  }

  if (!Array.isArray(batteries) || batteries.length === 0) {
    await logError({
      type: "PRECHECK_FAILED",
      message: "Precheck failed: no batteries",
      metadata: { stage: "precheck", reason_code: "NO_BATTERIES", stationCode },
    });
    return paymentFailed(
      {
        status: "failed",
        stage: "precheck",
        reason_code: "NO_BATTERIES",
        error: "Ma jiro battery diyaar ah",
        fault: "system",
      },
      409,
    );
  }

  const hasAboveThreshold = batteries.some((battery) => {
    const capacity = Number.parseInt(String(battery.battery_capacity || "0"), 10);
    return Number.isFinite(capacity) && capacity >= MIN_AVAILABLE_BATTERY_PERCENT;
  });

  if (!hasAboveThreshold) {
    await logError({
      type: "PRECHECK_FAILED",
      message: "Precheck failed: low battery inventory",
      metadata: { stage: "precheck", reason_code: "LOW_BATTERY", stationCode, threshold: MIN_AVAILABLE_BATTERY_PERCENT },
    });
    return paymentFailed(
      {
        status: "failed",
        stage: "precheck",
        reason_code: "LOW_BATTERY",
        error: "Battery-yadu wali way dallacayaan",
        fault: "system",
      },
      409,
    );
  }

  return NextResponse.json({
    status: "ok",
    stage: "precheck",
  });
}
