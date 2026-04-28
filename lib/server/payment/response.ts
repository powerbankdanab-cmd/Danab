import { NextResponse } from "next/server";

export type PaymentStage = "precheck" | "payment" | "delivery" | "unlock" | "verification" | "capture" | "system";
export type PaymentFault = "user" | "system";

export type PaymentReasonCode =
  | "STATION_OFFLINE"
  | "NO_BATTERIES"
  | "LOW_BATTERY"
  | "USER_CANCELLED"
  | "INSUFFICIENT_FUNDS"
  | "PAYMENT_TIMEOUT"
  | "PROVIDER_DECLINED"
  | "PROVIDER_ERROR"
  | "VERIFICATION_FAILED"
  | "VERIFICATION_TIMEOUT"
  | "UNLOCK_FAILED"
  | "UNLOCK_TIMEOUT"
  | "SLA_BREACH"
  | "INVALID_INITIAL_STATE"
  | "INVALID_REQUEST"
  | "INVALID_STATION";

export type PaymentFailedContract = {
  status: "failed";
  stage: PaymentStage;
  reason_code: PaymentReasonCode | string;
  error: string;
  fault: PaymentFault;
};

export function paymentFailed(
  input: PaymentFailedContract,
  httpStatus = 400,
) {
  return NextResponse.json(input, { status: httpStatus });
}
