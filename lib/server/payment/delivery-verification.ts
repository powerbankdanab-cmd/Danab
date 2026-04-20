import { 
  BatteryPresence, 
  BatterySnapshot, 
  DeliveryConfidence, 
  VerificationResult 
} from "./types";
import { queryStationBatteries } from "./heycharge";
import { normalizeBatteryId } from "./battery-id";
import { logError } from "../alerts/log-error";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Multi-phase delivery verification with confidence scoring.
 * 
 * Phase 1: 4 polls at 500ms intervals. Requires 2 consecutive "missing" to pass.
 * Phase 2: Wait 2-3s, then 2 polls. Requires stable "missing" for HIGH confidence.
 */
export async function verifyDeliveryWithConfidence(
  imei: string,
  batteryId: string,
  slotId: string,
  metadata: {
    stationCode: string;
    phoneNumber: string;
    transactionId: string;
  }
): Promise<VerificationResult> {
  const snapshots: BatterySnapshot[] = [];
  const startTime = Date.now();

  const getSnapshot = async (): Promise<BatterySnapshot> => {
    try {
      const stationBatteries = await queryStationBatteries(imei);
      const found = stationBatteries.find(
        (battery) =>
          normalizeBatteryId(battery.battery_id) === normalizeBatteryId(batteryId) &&
          battery.slot_id === slotId,
      );

      const snapshot: BatterySnapshot = found
        ? {
            presence: "present",
            lockStatus: found.lock_status || null,
            slotStatus: found.slot_status || null,
            batteryStatus: found.battery_status || null,
            observedAt: Date.now(),
          }
        : {
            presence: "missing",
            lockStatus: null,
            slotStatus: null,
            batteryStatus: null,
            observedAt: Date.now(),
          };
      snapshots.push(snapshot);
      return snapshot;
    } catch (error) {
      const snapshot: BatterySnapshot = {
        presence: "unknown",
        lockStatus: null,
        slotStatus: null,
        batteryStatus: null,
        observedAt: Date.now(),
      };
      snapshots.push(snapshot);
      return snapshot;
    }
  };

  // --- Phase 1 ---
  let phase1Result: BatteryPresence = "present";
  let consecutiveMissing = 0;
  for (let i = 0; i < 4; i++) {
    await delay(500);
    const snapshot = await getSnapshot();
    if (snapshot.presence === "missing") {
      consecutiveMissing++;
    } else {
      consecutiveMissing = 0;
    }
    if (consecutiveMissing >= 2) {
      phase1Result = "missing";
      break;
    }
  }

  // --- Phase 2 ---
  await delay(2500); // Wait 2.5s
  let phase2Result: BatteryPresence = "missing";
  let phase2Snapshots: BatteryPresence[] = [];
  
  for (let i = 0; i < 2; i++) {
    const snapshot = await getSnapshot();
    phase2Snapshots.push(snapshot.presence);
    if (snapshot.presence !== "missing") {
      phase2Result = snapshot.presence;
    }
    if (i === 0) await delay(500);
  }

  // --- Confidence Model ---
  let confidence: DeliveryConfidence = "LOW";
  const phase2Stable = phase2Snapshots.every(p => p === "missing");
  
  if (phase1Result === "missing" && phase2Stable) {
    confidence = "HIGH";
  } else if (phase1Result === "missing" && !phase2Stable) {
    confidence = "MEDIUM";
  } else {
    confidence = "LOW";
  }

  // --- Logic for False Positive detection ---
  const presenceSequence = snapshots.map(s => s.presence);
  const detectedFalseEjection = 
    (presenceSequence.includes("missing") && presenceSequence[presenceSequence.length - 1] === "present") ||
    (presenceSequence.filter(p => p === "missing").length === 1);

  if (detectedFalseEjection) {
    await logError({
      type: "FALSE_EJECTION_PATTERN",
      stationCode: metadata.stationCode,
      phoneNumber: metadata.phoneNumber,
      transactionId: metadata.transactionId,
      message: "Suspicious ejection pattern detected: battery appeared missing then present, or missing only once",
      metadata: {
        sequence: presenceSequence,
        snapshots
      }
    });
  }

  // --- Diagnostic Logging (Mandatory) ---
  await logError({
    type: "DELIVERY_VERIFICATION",
    stationCode: metadata.stationCode,
    phoneNumber: metadata.phoneNumber,
    transactionId: metadata.transactionId,
    message: `Delivery verification completed with ${confidence} confidence`,
    metadata: {
      imei,
      batteryId,
      slotId,
      snapshots,
      phase1Result,
      phase2Result,
      confidence,
      durationMs: Date.now() - startTime
    }
  });

  return { confidence, snapshots, phase1Result, phase2Result };
}
