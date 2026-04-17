import Twilio from "twilio";

import { getOptionalEnv } from "@/lib/server/env";

const ALERT_RATE_LIMIT_MS = 5_000;
let nextAllowedAlertAt = 0;

export type WhatsAppAlertResult =
  | "sent"
  | "rate_limited"
  | "missing_config"
  | "failed";

function readWhatsAppConfig() {
  const accountSid = getOptionalEnv("TWILIO_ACCOUNT_SID");
  const authToken = getOptionalEnv("TWILIO_AUTH_TOKEN");
  const from = getOptionalEnv("TWILIO_WHATSAPP_FROM");
  const to = getOptionalEnv("TWILIO_WHATSAPP_TO");

  if (!accountSid || !authToken || !from || !to) {
    return null;
  }

  return { accountSid, authToken, from, to };
}

export function getWhatsAppAlertRateLimitState() {
  const now = Date.now();
  return {
    nextAllowedAlertAt,
    waitMs: Math.max(nextAllowedAlertAt - now, 0),
  };
}

export async function sendWhatsAppAlertWithResult(
  message: string,
): Promise<WhatsAppAlertResult> {
  try {
    const config = readWhatsAppConfig();
    if (!config) {
      console.warn("WhatsApp alert skipped: missing Twilio env configuration.");
      return "missing_config";
    }

    const now = Date.now();
    if (now < nextAllowedAlertAt) {
      console.warn(
        `WhatsApp alert rate-limited. Try again in ${nextAllowedAlertAt - now}ms`,
      );
      return "rate_limited";
    }
    nextAllowedAlertAt = now + ALERT_RATE_LIMIT_MS;

    const client = Twilio(config.accountSid, config.authToken);
    await client.messages.create({
      from: config.from,
      to: config.to,
      body: message,
    });
    return "sent";
  } catch (error) {
    console.error(
      "Failed to send WhatsApp alert:",
      error instanceof Error ? error.message : error,
    );
    return "failed";
  }
}

export async function sendWhatsAppAlert(message: string): Promise<void> {
  try {
    await sendWhatsAppAlertWithResult(message);
  } catch {
    // no-op; fail-safe wrapper
  }
}
