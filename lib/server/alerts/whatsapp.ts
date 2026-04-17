import Twilio from "twilio";

import { getOptionalEnv } from "@/lib/server/env";

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

export async function sendWhatsAppAlert(message: string): Promise<void> {
  try {
    const config = readWhatsAppConfig();
    if (!config) {
      console.warn("WhatsApp alert skipped: missing Twilio env configuration.");
      return;
    }

    const client = Twilio(config.accountSid, config.authToken);
    await client.messages.create({
      from: config.from,
      to: config.to,
      body: message,
    });
  } catch (error) {
    console.error(
      "Failed to send WhatsApp alert:",
      error instanceof Error ? error.message : error,
    );
  }
}

