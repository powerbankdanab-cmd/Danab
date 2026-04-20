import { getOptionalEnv, getRequiredEnv } from "@/lib/server/env";

import { parseResponseBody, toErrorMessage } from "@/lib/server/payment/http";
import { WaafiResponse } from "@/lib/server/payment/types";

const WAAFI_REQUEST_TIMEOUT_MS = 20_000;

type WaafiServiceName =
  | "API_PURCHASE"
  | "API_PREAUTHORIZE"
  | "API_PREAUTHORIZE_COMMIT"
  | "API_PREAUTHORIZE_CANCEL"
  | "API_QUERY_TRANSACTION";

function normalizePhoneDigits(value: string) {
  const digits = value.replace(/\D/g, "");

  if (digits.startsWith("252") && digits.length > 9) {
    return digits.slice(-9);
  }

  return digits;
}

async function requestWaafiAction({
  serviceName,
  serviceParams,
}: {
  serviceName: WaafiServiceName;
  serviceParams: Record<string, unknown>;
}) {
  const payload = {
    schemaVersion: "1.0",
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    channelName: "WEB",
    serviceName,
    serviceParams: {
      merchantUid: getRequiredEnv("WAAFI_MERCHANT_UID"),
      apiUserId: getRequiredEnv("WAAFI_API_USER_ID"),
      apiKey: getRequiredEnv("WAAFI_API_KEY"),
      ...serviceParams,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, WAAFI_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(getRequiredEnv("WAAFI_URL"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Waafi request timed out");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const responsePayload = (await parseResponseBody(response)) as WaafiResponse | string | null;

  if (!response.ok) {
    throw new Error(toErrorMessage(responsePayload, "Waafi request failed"));
  }

  return (responsePayload || {}) as WaafiResponse;
}

export async function requestWaafiPreauthorization({
  phoneNumber,
  amount,
  referenceId,
}: {
  phoneNumber: string;
  amount: number;
  referenceId: string;
}) {
  return requestWaafiAction({
    serviceName: "API_PREAUTHORIZE",
    serviceParams: {
      paymentMethod: "MWALLET_ACCOUNT",
      payerInfo: { accountNo: phoneNumber },
      transactionInfo: {
        referenceId,
        amount: amount.toFixed(2),
        currency: "USD",
        description: "Powerbank rental hold",
      },
    },
  });
}

export async function commitWaafiPreauthorization({
  transactionId,
  description,
}: {
  transactionId: string;
  description?: string;
}) {
  return requestWaafiAction({
    serviceName: "API_PREAUTHORIZE_COMMIT",
    serviceParams: {
      transactionId,
      description: description || "Powerbank rental committed",
    },
  });
}

export async function cancelWaafiPreauthorization({
  transactionId,
  description,
}: {
  transactionId: string;
  description?: string;
}) {
  return requestWaafiAction({
    serviceName: "API_PREAUTHORIZE_CANCEL",
    serviceParams: {
      transactionId,
      description: description || "Powerbank rental cancelled",
    },
  });
}

export async function queryWaafiTransactionStatus({
  transactionId,
  referenceId,
}: {
  transactionId?: string | null;
  referenceId?: string | null;
}) {
  const serviceName =
    (getOptionalEnv("WAAFI_TRANSACTION_STATUS_SERVICE") as WaafiServiceName | null) ||
    "API_QUERY_TRANSACTION";

  const serviceParams: Record<string, unknown> = {};
  if (transactionId) {
    serviceParams.transactionId = transactionId;
  }
  if (referenceId) {
    serviceParams.referenceId = referenceId;
  }

  if (!serviceParams.transactionId && !serviceParams.referenceId) {
    throw new Error("Missing transactionId/referenceId for Waafi status query");
  }

  return requestWaafiAction({
    serviceName,
    serviceParams,
  });
}

export function isWaafiApproved(waafiResponse: WaafiResponse) {
  const responseCodeApproved =
    waafiResponse.responseCode === "2001" || waafiResponse.responseCode === 2001;
  const stateApproved =
    String(waafiResponse.params?.state || "").trim().toUpperCase() === "APPROVED";

  return responseCodeApproved && stateApproved;
}

export function extractWaafiIds(waafiResponse: WaafiResponse) {
  return {
    transactionId: waafiResponse.params?.transactionId || null,
    issuerTransactionId: waafiResponse.params?.issuerTransactionId || null,
    referenceId: waafiResponse.params?.referenceId || null,
  };
}

export function extractWaafiAudit(waafiResponse: WaafiResponse) {
  const rawAccountNo = String(waafiResponse.params?.accountNo || "");
  const waafiConfirmedPhoneNumber =
    rawAccountNo && !rawAccountNo.includes("*")
      ? normalizePhoneDigits(rawAccountNo) || null
      : null;

  return {
    waafiResponseCode:
      waafiResponse.responseCode !== undefined && waafiResponse.responseCode !== null
        ? String(waafiResponse.responseCode)
        : null,
    waafiErrorCode: waafiResponse.errorCode || null,
    waafiResponseMsg: waafiResponse.responseMsg || null,
    waafiResponseId: waafiResponse.responseId || null,
    waafiResponseTimestamp: waafiResponse.timestamp || null,
    waafiState: waafiResponse.params?.state || null,
    waafiAccountNo: waafiResponse.params?.accountNo || null,
    waafiConfirmedPhoneNumber,
    waafiAccountType: waafiResponse.params?.accountType || null,
    waafiMerchantCharges: waafiResponse.params?.merchantCharges || null,
    waafiTxAmount: waafiResponse.params?.txAmount || null,
  };
}

export function mergeWaafiAuditRecords(
  ...audits: Array<Record<string, unknown> | undefined>
) {
  const merged: Record<string, unknown> = {};

  for (const audit of audits) {
    if (!audit) {
      continue;
    }

    for (const [key, value] of Object.entries(audit)) {
      if (value !== undefined && value !== null && value !== "") {
        merged[key] = value;
      }
    }
  }

  return merged;
}

export function getWaafiLifecycleState(waafiResponse: WaafiResponse): string {
  return String(waafiResponse.params?.state || "")
    .trim()
    .toUpperCase();
}

export function isWaafiCaptured(waafiResponse: WaafiResponse): boolean {
  const state = getWaafiLifecycleState(waafiResponse);
  return state === "APPROVED" || state === "COMMITTED" || state === "SUCCESS";
}

export function isWaafiCancelled(waafiResponse: WaafiResponse): boolean {
  const state = getWaafiLifecycleState(waafiResponse);
  return state === "CANCELLED" || state === "REVERSED" || state === "FAILED";
}

function classifyWaafiPaymentStatus(
  statusResponse: WaafiResponse,
): "pending" | "paid" | "cancelled" | "failed" | "unknown" {
  if (isWaafiApproved(statusResponse)) {
    return "paid";
  }

  const state = getWaafiLifecycleState(statusResponse);
  const responseCode = String(statusResponse.responseCode || "").trim();
  const responseMsg = String(statusResponse.responseMsg || "").toLowerCase();
  const errorCode = String(statusResponse.errorCode || "").toLowerCase();
  const combinedReason = `${responseMsg} ${errorCode}`;

  const cancelledTerms = [
    "cancel",
    "dismiss",
    "abandon",
    "abort",
    "user cancelled",
    "closed by user",
    "timeout waiting pin",
  ];
  const failedTerms = [
    "wrong pin",
    "invalid pin",
    "rejected",
    "declined",
    "denied",
    "insufficient",
    "failed",
  ];

  if (
    state === "CANCELLED" ||
    state === "REVERSED" ||
    state === "ABANDONED" ||
    state === "EXPIRED" ||
    cancelledTerms.some((term) => combinedReason.includes(term))
  ) {
    return "cancelled";
  }

  if (
    state === "FAILED" ||
    state === "DECLINED" ||
    state === "REJECTED" ||
    failedTerms.some((term) => combinedReason.includes(term))
  ) {
    return "failed";
  }

  if (responseCode === "2001") {
    return "paid";
  }

  if (
    responseCode === "2002" ||
    responseCode === "2003" ||
    state === "INITIATED" ||
    state === "PENDING" ||
    state === "PROCESSING" ||
    combinedReason.includes("pending") ||
    combinedReason.includes("processing") ||
    combinedReason.includes("waiting")
  ) {
    return "pending";
  }

  // Defensive fallback: if provider returned a concrete terminal-like response
  // we don't recognize, prefer failed over "pending forever".
  if (responseCode && responseCode !== "2002" && responseCode !== "2003") {
    return "failed";
  }

  return "unknown";
}

export async function checkPaymentStatus(
  providerRef?: string | null,
  providerReferenceId?: string | null,
): Promise<"pending" | "paid" | "cancelled" | "failed" | "unknown"> {
  if (!providerRef && !providerReferenceId) {
    return "unknown";
  }

  try {
    if (providerRef) {
      const byTransactionId = await queryWaafiTransactionStatus({
        transactionId: providerRef,
      });
      const transactionStatus = classifyWaafiPaymentStatus(byTransactionId);
      if (transactionStatus !== "unknown") {
        return transactionStatus;
      }
    }

    if (providerReferenceId) {
      const byReferenceId = await queryWaafiTransactionStatus({
        referenceId: providerReferenceId,
      });
      return classifyWaafiPaymentStatus(byReferenceId);
    }

    return "unknown";
  } catch (error) {
    console.error("Failed to check payment status:", error);
    return "unknown";
  }
}
