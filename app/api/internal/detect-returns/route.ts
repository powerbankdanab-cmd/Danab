import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { queryStationBatteries } from "@/lib/server/payment/heycharge";
import { markRentalReturned } from "@/lib/server/payment/rentals";
import { logError } from "@/lib/server/alerts/log-error";

/**
 * Internal API to detect battery returns by polling station inventory.
 * This should be called periodically (e.g., every 1-5 minutes).
 */
export async function GET() {
  try {
    const db = getDb();
    
    // 1. Get all stations (or active ones)
    // For this demonstration, we'll assume there's a 'stations' collection
    const stationsSnap = await db.collection("stations").get();
    
    const results = {
      stationsScanned: 0,
      returnsDetected: 0,
      errors: 0
    };

    for (const stationDoc of stationsSnap.docs) {
      const station = stationDoc.data();
      const imei = station.imei;
      const stationCode = station.code || stationDoc.id;

      if (!imei) continue;

      try {
        // 2. Query current inventory from HeyCharge
        const currentBatteries = await queryStationBatteries(imei);
        results.stationsScanned++;

        // 3. For each battery currently in the station, check if it was recently returned
        for (const battery of currentBatteries) {
          if (!battery.battery_id) continue;

          // The trigger logic: if a battery is PRESENT in a slot, we attempt to mark it as returned.
          // markRentalReturned handles finding the active rental for this batteryId.
          // If no active rental exists, it's a no-op (battery is already returned or was never rented).
          await markRentalReturned({
            batteryId: battery.battery_id,
            returnStationId: stationCode,
            currentState: "present"
          });
        }
      } catch (stationError) {
        results.errors++;
        console.error(`[RETURN_POLL_FAILED] Station ${stationCode}:`, stationError);
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    console.error("[DETECT_RETURNS_CRASHED]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

