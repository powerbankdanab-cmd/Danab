import { PaymentMethod, TimeOption } from "@/components/payment/types";

export const TIME_OPTIONS: TimeOption[] = [
  { label: "$0.75", amount: 0.75, icon: "clock" },
];

export const PAYMENT_METHODS: PaymentMethod[] = ["EVC Plus", "ZAAD", "SAHAL"];

export const PHONE_PLACEHOLDER_BY_METHOD: Record<PaymentMethod, string> = {
  "EVC Plus": "61 xxxxx",
  ZAAD: "63 xxxxx",
  SAHAL: "37 xxxxx",
};
