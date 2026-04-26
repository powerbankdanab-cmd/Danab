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
  },
  unlockStartedAt: number,
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

      const slotOccupiedByOtherBattery = stationBatteries.some(
        (battery) =>
          battery.slot_id === slotId &&
          normalizeBatteryId(battery.battery_id) !== normalizeBatteryId(batteryId),
      );

      const snapshot: BatterySnapshot = found
        ? {
          presence: "present",
          lockStatus: found.lock_status || null,
          slotStatus: found.slot_status || null,
          batteryStatus: found.battery_status || null,
          observedAt: Date.now(),
          slotOccupiedByOtherBattery: false,
        }
        : {
          presence: "missing",
          lockStatus: null,
          slotStatus: null,
          batteryStatus: null,
          observedAt: Date.now(),
          slotOccupiedByOtherBattery,
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
  await delay(3000); // Longer window for hardware / sensor latency
  let phase2Result: BatteryPresence = "missing";
  const phase2Snapshots: BatteryPresence[] = [];

  for (let i = 0; i < 2; i++) {
    const snapshot = await getSnapshot();
    phase2Snapshots.push(snapshot.presence);
    if (snapshot.presence !== "missing") {
      phase2Result = snapshot.presence;
    }
    if (i === 0) await delay(500);
  }

  // --- Extended window ---
  const extendedSnapshots: BatteryPresence[] = [];
  let extendedConsecutiveMissing = 0;
  for (let i = 0; i < 3; i++) {
    const snapshot = await getSnapshot();
    extendedSnapshots.push(snapshot.presence);
    if (snapshot.presence === "missing") {
      extendedConsecutiveMissing++;
    } else {
      extendedConsecutiveMissing = 0;
    }
    if (extendedConsecutiveMissing >= 2) {
      break;
    }
    await delay(1000);
  }

  // --- Confidence Model ---
  const phase2Stable = phase2Snapshots.every((p) => p === "missing");
  const extendedStableMissing = extendedConsecutiveMissing >= 2;
  const missingDetectedAt = snapshots.find((snapshot) => snapshot.presence === "missing")?.observedAt ?? null;
  const causalityInvalid =
    missingDetectedAt !== null && missingDetectedAt <= unlockStartedAt;
  const presenceSequence = snapshots.map((s) => s.presence);
  const firstMissingIndex = presenceSequence.indexOf("missing");
  const presentAfterMissing =
    firstMissingIndex !== -1 &&
    presenceSequence.slice(firstMissingIndex + 1).some((presence) => presence === "present");
  const missingOnlyOnce = presenceSequence.filter((p) => p === "missing").length === 1;

  let confidence: DeliveryConfidence = "LOW";
  if (presentAfterMissing) {
    confidence = "LOW";
  } else if (
    !causalityInvalid &&
    ((phase1Result === "missing" && phase2Stable) || extendedStableMissing)
  ) {
    confidence = "HIGH";
  } else if (!causalityInvalid && snapshots.some((snapshot) => snapshot.presence === "missing")) {
    confidence = "MEDIUM";
  } else {
    confidence = "LOW";
  }

  // --- Logic for False Positive detection ---
  const detectedFalseEjection =
    presentAfterMissing ||
    missingOnlyOnce;

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
      presenceSequence,
      phase1Result,
      phase2Result,
      confidence,
      missingDetectedAt,
      unlockStartedAt,
      durationMs: Date.now() - startTime,
      causalityInvalid,
      presentAfterMissing,
      missingOnlyOnce,
      phase2Stable,
      extendedStableMissing,
      counts: {
        present: presenceSequence.filter((p) => p === "present").length,
        missing: presenceSequence.filter((p) => p === "missing").length,
        unknown: presenceSequence.filter((p) => p === "unknown").length,
      },
    }
  });

  if (causalityInvalid) {
    await logError({
      type: "FALSE_EJECTION_PATTERN",
      stationCode: metadata.stationCode,
      phoneNumber: metadata.phoneNumber,
      transactionId: metadata.transactionId,
      message: "Missing signal was detected before unlock completed; ignoring early missing signal",
      metadata: {
        unlockStartedAt,
        missingDetectedAt,
        sequence: presenceSequence,
        snapshots,
      },
    });
  }

  return { confidence, snapshots, phase1Result, phase2Result, missingDetectedAt };
}
