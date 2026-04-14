import { headers } from "next/headers";

import { getRequiredEnv } from "@/lib/server/env";
import { getStationConfigByDomain } from "@/lib/server/station-config";

export async function getActiveStationCode() {
  const headersList = await headers();
  const host = headersList.get("host") || "";

  const config = getStationConfigByDomain(host);
  if (config?.code) {
    return config.code;
  }

  return getRequiredEnv("STATION_CODE");
}

export async function getStationImei() {
  const headersList = await headers();
  const host = headersList.get("host") || "";

  const config = getStationConfigByDomain(host);
  if (config?.imei) {
    return config.imei;
  }

  return getRequiredEnv("STATION_IMEI");
}
