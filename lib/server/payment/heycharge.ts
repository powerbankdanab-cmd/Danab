import { getRequiredEnv } from "@/lib/server/env";

import { getDb } from "@/lib/server/firebase-admin";
import { normalizeBatteryId } from "@/lib/server/payment/battery-id";
import { getReservedBatteryIds } from "@/lib/server/payment/battery-lock";
import { parseResponseBody, toErrorMessage } from "@/lib/server/payment/http";
import { Battery } from "@/lib/server/payment/types";
import { getActiveRentedBatteryIds } from "@/lib/server/payment/rentals";

type HeyChargeStationResponse = {
  batteries?: Battery[];
};

const HEYCHARGE_QUERY_TIMEOUT_MS = 20_000;
const HEYCHARGE_RELEASE_TIMEOUT_MS = 25_000;
export const MIN_AVAILABLE_BATTERY_PERCENT = 60;

function buildHeyChargeAuthHeader() {
  const apiKey = getRequiredEnv("HEYCHARGE_API_KEY");
  const basicToken = Buffer.from(`${apiKey}:`).toString("base64");
  return `Basic ${basicToken}`;
}

/**
 * Query HeyCharge for all batteries currently in the station.
 * Reusable for both initial selection and post-timeout recheck.
 */
export async function queryStationBatteries(imei: string): Promise<Battery[]> {
  const domain = getRequiredEnv("HEYCHARGE_DOMAIN");
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, HEYCHARGE_QUERY_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${domain}/v1/station/${imei}`, {
      headers: {
        Authorization: buildHeyChargeAuthHeader(),
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Station query timed out");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const payload = (await parseResponseBody(response)) as
    | HeyChargeStationResponse
    | string
    | null;

  if (!response.ok) {
    throw new Error(
      toErrorMessage(payload, "Failed to query station batteries"),
    );
  }

  const payloadObject =
    payload && typeof payload === "object"
      ? (payload as HeyChargeStationResponse)
      : null;

  return Array.isArray(payloadObject?.batteries) ? payloadObject.batteries : [];
}

/**
 * Get problem slot IDs for a station from Firestore.
 */
async function getProblemSlotIds(imei: string): Promise<Set<string>> {
  const snap = await getDb()
    .collection("problem_slots")
    .where("imei", "==", imei)
    .where("resolved", "==", false)
    .get();

  const ids = new Set<string>();
  for (const doc of snap.docs) {
    const slotId = doc.data().slot_id;
    if (slotId) ids.add(slotId);
  }
  return ids;
}

/**
 * Mark a slot as a problem slot in Firestore.
 */
export async function markProblemSlot(
  imei: string,
  slotId: string,
  batteryId: string,
  reason: string,
) {
  await getDb().collection("problem_slots").add({
    imei,
    slot_id: slotId,
    battery_id: normalizeBatteryId(batteryId) || batteryId,
    reason,
    resolved: false,
    createdAt: new Date(),
  });
  console.error(
    `⚠️ Marked slot ${slotId} on station ${imei} as problem: ${reason}`,
  );
}

function normalizeHeyChargeState(value?: string | null): string {
  return String(value || "").trim().toLowerCase();
}

function isHealthyHeyChargeState(value?: string | null): boolean {
  const normalized = normalizeHeyChargeState(value);

  if (!normalized) {
    return true;
  }

  return [
    "normal",
    "online",
    "available",
    "ok",
    "healthy",
    "1",
  ].includes(normalized);
}

function isBatteryRentable(battery: Battery, problemSlots: Set<string>) {
  const capacity = Number.parseInt(battery.battery_capacity, 10);
  const hasHealthySlot = isHealthyHeyChargeState(battery.slot_status);
  const hasHealthyBatteryState = isHealthyHeyChargeState(battery.battery_status);

  return (
    Boolean(normalizeBatteryId(battery.battery_id)) &&
    Boolean(battery.slot_id) &&
    battery.lock_status === "1" &&
    capacity >= MIN_AVAILABLE_BATTERY_PERCENT &&
    battery.battery_abnormal === "0" &&
    battery.cable_abnormal === "0" &&
    hasHealthySlot &&
    hasHealthyBatteryState &&
    !problemSlots.has(battery.slot_id)
  );
}

export async function getAvailableBattery(imei: string) {
  const batteries = await queryStationBatteries(imei);
  const batteryIds = batteries.map((battery) => battery.battery_id);

  const [problemSlots, reservedIds, rentedIds] = await Promise.all([
    getProblemSlotIds(imei),
    getReservedBatteryIds(imei),
    getActiveRentedBatteryIds(batteryIds),
  ]);

  const available = batteries
    .filter(
      (battery) =>
        isBatteryRentable(battery, problemSlots) &&
        !reservedIds.has(normalizeBatteryId(battery.battery_id)) &&
        !rentedIds.has(normalizeBatteryId(battery.battery_id)),
    )
    .sort(
      (a, b) =>
        Number.parseInt(b.battery_capacity, 10) -
        Number.parseInt(a.battery_capacity, 10),
    );

  return available[0] || null;
}

export async function isSpecificBatteryReadyForRental({
  imei,
  batteryId,
  slotId,
}: {
  imei: string;
  batteryId: string;
  slotId: string;
}) {
  const normalizedBatteryId = normalizeBatteryId(batteryId);
  if (!normalizedBatteryId) {
    return false;
  }

  const [batteries, problemSlots, rentedIds] = await Promise.all([
    queryStationBatteries(imei),
    getProblemSlotIds(imei),
    getActiveRentedBatteryIds([normalizedBatteryId]),
  ]);

  const battery = batteries.find(
    (entry) =>
      normalizeBatteryId(entry.battery_id) === normalizedBatteryId &&
      entry.slot_id === slotId,
  );

  if (!battery) {
    return false;
  }

  return (
    isBatteryRentable(battery, problemSlots) &&
    !rentedIds.has(normalizedBatteryId)
  );
}

export async function releaseBattery({
  imei,
  batteryId,
  slotId,
}: {
  imei: string;
  batteryId: string;
  slotId: string;
}) {
  const domain = getRequiredEnv("HEYCHARGE_DOMAIN");
  const url = new URL(`${domain}/v1/station/${imei}`);
  url.searchParams.set("battery_id", batteryId);
  url.searchParams.set("slot_id", slotId);

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, HEYCHARGE_RELEASE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: buildHeyChargeAuthHeader(),
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Battery unlock request timed out");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const payload = await parseResponseBody(response);

  if (!response.ok) {
    throw new Error(toErrorMessage(payload, "Battery unlock failed"));
  }

  return payload;
}
