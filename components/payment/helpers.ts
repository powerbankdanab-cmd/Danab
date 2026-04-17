import { PaymentErrors } from "@/components/payment/types";

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function formatAmount(amount: number) {
  return `$${amount.toFixed(2)}`;
}

export function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

export function validatePaymentInput(
  phone: string,
  agreeRules: boolean,
): PaymentErrors {
  const errors: PaymentErrors = {};
  const cleanPhone = normalizePhone(phone);

  if (!cleanPhone || cleanPhone.length < 7) {
    errors.phone = "Fadlan gali number sax ah (ugu yaraan 7 digit)";
  }

  if (!agreeRules) {
    errors.agreeRules = "Fadlan ogolow shuruudaha isticmaalka";
  }

  return errors;
}

export function mapBackendErrorMessage(message: string, waafiMsg?: string) {
  // If backend already returned Somali text, display it directly.
  if (/[\u0600-\u06FF]/.test(message) || message.includes("Fadlan") || message.includes("Khalad")) {
    return message;
  }

  const lowerMessage = message.toLowerCase();

  if (message.includes("No available battery")) {
    return "Ma jiro baytari diyaar ah hadda. Station-ku waa la damiyay ama battery-gu way dhammaadeen.";
  }

  if (
    message.includes("Station query timed out") ||
    message.includes("Failed to query station")
  ) {
    return "Station-ku hadda ma shaqeynayo (offline). Fadlan isku day mar kale ama la xiriir: 616586503";
  }

  if (message.includes("already have an active rental")) {
    return "Waxaad hore u haysataa battery, fadlan soo celi midkaas ka hor intaadan mid kale kireysanin";
  }

  if (message.includes("already being processed")) {
    return "Lacag bixinta number-kan horey ayay u socotaa. Fadlan sug wax yar oo hubi natiijada codsigii hore.";
  }

  if (message.includes("battery is already rented")) {
    return "Battery-gan waa la kireystay, fadlan mar kale isku day";
  }

  if (message.includes("blocked") || message.includes("blacklist")) {
    return "Adigu waxaad ku jirtaa liiska mamnuucida. Fadlan nala soo xiriir: 616586503";
  }

  if (message.includes("Payment not approved")) {
    if (waafiMsg) {
      return waafiMsg;
    }
    return "Lacag bixinta ma dhicin, fadlan hubi numberkaaga iyo haraagaaga";
  }

  if (message.includes("Payment hold not approved")) {
    if (waafiMsg) {
      return waafiMsg;
    }
    return "Waafi ma ogolaan hold-ka lacagta. Fadlan hubi numberkaaga iyo haraagaaga.";
  }

  if (message.includes("Payment hold was approved")) {
    return "Waafi hold-ku wuu dhacay, laakiin transaction ID lama helin. Fadlan mar kale isku day.";
  }

  if (message.includes("Battery could not be released. Payment hold was cancelled.")) {
    return "Battery-gu ma soo bixin. Hold-kii lacagta waa la cancel gareeyay, lacag kama bixin doontid.";
  }

  if (
    message.includes(
      "Battery could not be released and payment hold cancellation could not be confirmed.",
    )
  ) {
    return "Battery-gu ma soo bixin, laakiin cancel-ka hold-ka lama xaqiijin. Fadlan la xiriir support-ka Danab.";
  }

  if (
    message.includes(
      "Battery was released, but payment confirmation could not be completed.",
    )
  ) {
    return "Battery-gu wuu soo baxay, laakiin commit-ka lacagta lama xaqiijin. Fadlan la xiriir support-ka Danab.";
  }

  if (lowerMessage.includes("timed out") || lowerMessage.includes("timeout")) {
    return "Waqtigii codsiga wuu dhamaaday. Fadlan mar kale isku day.";
  }

  if (lowerMessage.includes("abort")) {
    return "Codsiga waa la joojiyay. Fadlan mar kale isku day.";
  }

  return "Khalad ayaa dhacay. Fadlan mar kale isku day ama la xiriir support-ka Danab.";
}
