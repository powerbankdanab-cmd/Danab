import { NextRequest, NextResponse } from "next/server";

import { isHttpError, processPayment } from "@/lib/server/payment-service";
import { reconcileTransactions } from "@/lib/server/payment/reconciliation";
import { logError } from "@/lib/server/alerts/log-error";

import { checkRateLimit } from "@/lib/server/rate-limit";

import { getClientIp } from "@/lib/server/request";

type PaymentRequestBody = {
  phoneNumber?: string;

  amount?: number;
  stationCode?: string;
  idempotencyKey?: string;
};

function toSomaliPaymentError(message: string) {
  const lower = String(message || "").toLowerCase();

  if (
    lower.includes("missing phonenumber") ||
    lower.includes("idempotencykey") ||
    lower.includes("valid amount") ||
    lower.includes("missing idempotency key")
  ) {
    return "Macluumaadku ma dhammeystirna: phone number, amount, ama idempotency key ayaa ka maqan.";
  }

  if (lower.includes("invalid json")) {
    return "Qoraalka codsiga waa khalad (JSON). Fadlan mar kale isku day.";
  }

  if (lower.includes("too many payment requests")) {
    return "Codsiyo badan ayaa la diray waqti gaaban. Fadlan sug wax yar kadib mar kale isku day.";
  }

  if (lower.includes("invalid station code")) {
    return "Koodhka station-ka waa khalad. Fadlan hubi link-ga station-ka.";
  }

  if (lower.includes("already being processed")) {
    return "Lacag bixintaadu hore ayay u socotaa. Fadlan sug natiijada codsigii hore.";
  }

  if (lower.includes("already have an active rental")) {
    return "Waxaad hore u haysataa battery active ah. Fadlan soo celi ka hor intaadan mid kale qaadan.";
  }

  if (lower.includes("blocked from renting") || lower.includes("blacklist")) {
    return "Lambarkan waa la xannibay. Fadlan la xiriir team-ka Danab.";
  }

  if (lower.includes("no available battery")) {
    return "Hadda ma jiro battery diyaar ah oo la bixin karo. Fadlan mar dambe isku day.";
  }

  if (lower.includes("payment hold not approved")) {
    return "Waafi ma ansixin hold-ka lacagta. Fadlan hubi number-ka iyo haraaga.";
  }

  if (lower.includes("waafi did not return a transaction id")) {
    return "Hold-ka waa la ansixiyey, laakiin transaction ID lama helin. Fadlan mar kale isku day.";
  }

  if (lower.includes("duplicate payment transaction")) {
    return "Transaction-kan hore ayaa loo isticmaalay. Codsi cusub samee.";
  }

  if (lower.includes("selected battery is no longer in slot")) {
    return "Battery-ga la doortay booskiisii kuma jiro hadda. Fadlan mar kale isku day.";
  }

  if (
    lower.includes(
      "battery could not be released and payment hold cancellation could not be confirmed",
    )
  ) {
    return "Battery-gu ma soo bixin, cancellation-ka hold-kana lama xaqiijin. Fadlan la xiriir support-ka.";
  }

  if (lower.includes("battery could not be released. payment hold was cancelled")) {
    return "Battery-gu ma soo bixin. Hold-kii lacagta waa la joojiyey, lacag lagaa qaadi maayo.";
  }

  if (
    lower.includes(
      "battery was released, but payment confirmation could not be completed",
    )
  ) {
    return "Battery-gu wuu soo baxay, laakiin xaqiijinta lacagta ma dhammaan. Fadlan la xiriir support-ka.";
  }

  if (lower.includes("payment state is under reconciliation")) {
    return "Xaaladda lacagta wali waa la hubinayaa (reconciliation). Fadlan sug ama mar kale isku day wax yar kadib.";
  }

  if (lower.includes("captured and is being repaired")) {
    return "Lacagtu waa dhacday, nidaamkuna wuu dayactirayaa diiwaanka. Fadlan sug daqiiqad oo mar kale isku day.";
  }

  if (lower.includes("invalid state")) {
    return "Xaaladda transaction-ka ma saxna codsigan. Fadlan mar kale isku day.";
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "Waqtiga codsigu wuu dhammaaday. Fadlan mar kale isku day.";
  }

  if (lower.includes("internal server error")) {
    return "Khalad server ah ayaa dhacay. Fadlan mar kale isku day.";
  }

  return "Khalad ayaa dhacay inta lacag bixintu socotay. Fadlan mar kale isku day ama la xiriir support-ka Danab.";
}

function parseAndValidateBody(body: PaymentRequestBody) {
  const phoneNumber =
    typeof body.phoneNumber === "string"
      ? body.phoneNumber.replace(/\D/g, "")
      : "";

  const amount = Number(body.amount);
  const stationCode =
    typeof body.stationCode === "string"
      ? body.stationCode.replace(/\D/g, "")
      : "";
  const idempotencyKey =
    typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";

  if (!phoneNumber || Number.isNaN(amount) || amount <= 0 || !idempotencyKey) {
    return {
      error: toSomaliPaymentError(
        "Missing phoneNumber, valid amount, or idempotencyKey",
      ),
    } as const;
  }

  return {
    phoneNumber,
    amount,
    ...(stationCode ? { stationCode } : {}),
    idempotencyKey,
  } as const;
}

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // Opportunistic self-healing in case scheduled cron is delayed/down.
  void reconcileTransactions(3).catch((error) => {
    void logError({
      type: "SYSTEM_INCONSISTENCY",
      message: "Opportunistic reconciliation failed",
      metadata: { error: error instanceof Error ? error.message : String(error) },
    });
  });

  const clientIp = getClientIp(request);

  const rateLimitResult = checkRateLimit(`payment:${clientIp}`, {
    windowMs: 5 * 60_000,

    max: 10,
  });

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: toSomaliPaymentError("Too many payment requests, please try again later.") },

      {
        status: 429,

        headers: {
          "Retry-After": String(rateLimitResult.retryAfterSeconds),
        },
      },
    );
  }

  let body: PaymentRequestBody;

  try {
    body = (await request.json()) as PaymentRequestBody;
  } catch {
    return NextResponse.json(
      { error: toSomaliPaymentError("Invalid JSON body") },
      { status: 400 },
    );
  }

  const parsed = parseAndValidateBody(body);

  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await processPayment(parsed);

    return NextResponse.json(result);
  } catch (error) {
    if (isHttpError(error)) {
      const payload = error.details
        ? {
          error: toSomaliPaymentError(error.message),

          ...(error.details as Record<string, unknown>),
        }
        : { error: toSomaliPaymentError(error.message) };

      return NextResponse.json(payload, { status: error.status });
    }

    const message =
      error instanceof Error ? error.message : "Internal server error";

    return NextResponse.json(
      { error: toSomaliPaymentError(message) },
      { status: 500 },
    );
  }
}
