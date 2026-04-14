import { getOptionalEnv } from "@/lib/server/env";

const TELEGRAM_TIMEOUT_MS = 8_000;

type PaidButNotEjectedAlertInput = {
  phoneNumber: string;
  amount: number;
  imei: string;
  stationCode: string;
  batteryId: string;
  slotId: string;
  transactionId: string | null;
  issuerTransactionId: string | null;
  referenceId: string | null;
  unlockAttempts: number;
  reason: string;
};

function buildAlertMessage(input: PaidButNotEjectedAlertInput) {
  const lines = [
    "🚨 Paid But Not Ejected",
    "",
    `👤 Phone: ${input.phoneNumber}`,
    `💵 Amount: $${input.amount.toFixed(2)}`,
    `🏢 Station: ${input.stationCode}`,
    `🧾 IMEI: ${input.imei}`,
    "",
    `🔋 Battery: ${input.batteryId}`,
    `🗂 Slot: ${input.slotId}`,
    `🔁 Unlock Attempts: ${input.unlockAttempts}`,
    "",
    `❗ Reason: ${input.reason}`,
    "",
    `💳 Waafi TX: ${input.transactionId || "-"}`,
    `🏦 Issuer TX: ${input.issuerTransactionId || "-"}`,
    `🔖 Reference: ${input.referenceId || "-"}`,
    "",
    `🕒 Time: ${new Date().toLocaleString("en-US", {
      timeZone: "Africa/Nairobi",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}`,
  ];

  return lines.join("\n");
}

export async function notifyPaidButNotEjected(
  input: PaidButNotEjectedAlertInput,
) {
  const botToken = getOptionalEnv("TELEGRAM_BOT_TOKEN");
  const chatId = getOptionalEnv("TELEGRAM_CHAT_ID");

  if (!botToken || !chatId) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: buildAlertMessage(input),
        }),
        cache: "no-store",
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(
        `Telegram sendMessage failed (${response.status}): ${payload}`,
      );
    }
  } catch (error) {
    console.error(
      "Failed to send Telegram paid-but-not-ejected alert:",
      error instanceof Error ? error.message : error,
    );
  } finally {
    clearTimeout(timeout);
  }
}
