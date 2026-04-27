import { ensureServerEnvLoaded } from "@/lib/server/env";

ensureServerEnvLoaded();

export { isPhoneBlacklisted } from "@/lib/server/payment/blacklist";
export { HttpError, isHttpError } from "@/lib/server/payment/errors";
export {
  createOrGetPaymentTransaction,
  getPaymentTransaction,
  patchPaymentTransaction,
  transitionPaymentTransactionState,
  listStaleTransactionsForReconciliation,
  listHeldTransactionsWithoutUnlock,
  claimTransactionRecovery,
  releaseTransactionRecovery,
  markUnlockStarted
} from "@/lib/server/payment/transactions";
export {
  processPayment,
  handleUserConfirmation,
  finalizeCapture,
  cancelHold,
  resumePendingPayment
} from "@/lib/server/payment/process-payment";
export {
  getProviderDrivenPaymentStatus,
  triggerUnlockIfNeeded,
  reconcileTransactionStatus,
} from "@/lib/server/payment/status";
export {
  getActiveStationCode,
  getStationImei,
} from "@/lib/server/payment/station";
export {
  queryWaafiTransactionStatus,
  isWaafiApproved,
  extractWaafiIds,
  extractWaafiAudit
} from "@/lib/server/payment/waafi";
export type { PaymentInput, PaymentPayload } from "@/lib/server/payment/types";
