import Twilio from "twilio";
import { getOptionalEnv } from "@/lib/server/env";

const ALERT_RATE_LIMIT_MS = 5_000;
let nextAllowedAlertAt = 0;

export type WhatsAppAlertResult =
  | "sent"
  | "rate_limited"
  | "missing_config"
  | "failed";

/**
 * Read and validate WhatsApp config
 */
function readWhatsAppConfig() {
  const accountSid = getOptionalEnv("TWILIO_ACCOUNT_SID");
  const authToken = getOptionalEnv("TWILIO_AUTH_TOKEN");
  const from = getOptionalEnv("TWILIO_WHATSAPP_FROM");
  const toRaw = getOptionalEnv("TWILIO_WHATSAPP_TO");

  if (!accountSid || !authToken || !from || !toRaw) {
    return null;
  }

  const recipients = toRaw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  if (recipients.length === 0) {
    return null;
  }

  return {
    accountSid,
    authToken,
    from,
    recipients,
  };
}

/**
 * Inspect rate limit state (for debugging)
 */
export function getWhatsAppAlertRateLimitState() {
  const now = Date.now();
  return {
    nextAllowedAlertAt,
    waitMs: Math.max(nextAllowedAlertAt - now, 0),
  };
}

/**
 * Send WhatsApp alert with result tracking
 */
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
        `WhatsApp alert rate-limited. Try again in ${nextAllowedAlertAt - now
        }ms`,
      );
      return "rate_limited";
    }

    // Apply global rate limit BEFORE sending
    nextAllowedAlertAt = now + ALERT_RATE_LIMIT_MS;

    const client = Twilio(config.accountSid, config.authToken);

    let successCount = 0;

    for (const to of config.recipients) {
      try {
        await client.messages.create({
          from: config.from,
          to,
          body: message,
        });

        successCount++;
      } catch (error) {
        console.error(
          `Failed to send WhatsApp alert to ${to}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    if (successCount > 0) {
      return "sent";
    }

    return "failed";
  } catch (error) {
    console.error(
      "Unexpected WhatsApp alert failure:",
      error instanceof Error ? error.message : error,
    );
    return "failed";
  }
}

/**
 * Fire-and-forget wrapper (never throws)
 */
export async function sendWhatsAppAlert(message: string): Promise<void> {
  try {
    await sendWhatsAppAlertWithResult(message);
  } catch {
    // Intentionally ignore to avoid breaking main flow
  }
}