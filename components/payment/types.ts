export type PaymentMethod = "EVC Plus" | "ZAAD" | "SAHAL";

export type PaymentStatus =
  | "CONNECTING"
  | "PENDING_PAYMENT"
  | "WAITING_PIN"
  | "PROCESSING"
  | "CONFIRM_REQUIRED"
  | "SUCCESS"
  | "FAILED";

export type ProcessingStep = "verify" | "hold" | "unlock" | "commit";

export type PaymentErrors = {
  phone?: string;
  agreeRules?: string;
};

export type TimeOption = {
  label: string;
  amount: number;
  icon: "clock" | "timer";
};
