import { NextResponse } from "next/server";

import { getPublicStationConfigs } from "@/lib/server/station-config";

export async function GET() {
  try {
    const stations = getPublicStationConfigs().map((station) => ({
      code: station.code,
      imei: station.imei,
      name: station.name.replace(/\n+/g, " ").trim(),
    }));

    return NextResponse.json({ stations }, { status: 200 });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch mobile stations" },
      { status: 500 },
    );
  }
}
