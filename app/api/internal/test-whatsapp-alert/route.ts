import { NextResponse } from "next/server";

import { sendWhatsAppAlert } from "@/lib/server/alerts/whatsapp";

export async function GET() {
  await sendWhatsAppAlert(
    `DANAB TEST ALERT\nTime: ${new Date().toISOString()}\nStatus: WhatsApp integration working`,
  );

  return NextResponse.json({ success: true });
}

