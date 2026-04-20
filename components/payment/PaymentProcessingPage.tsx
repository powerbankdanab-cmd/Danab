"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PAYMENT_METHODS } from "@/components/payment/constants";

import {
  CheckIcon,
  CloseIcon,
  ArrowRightIcon,
  HelpCircleIcon,
  ClockIcon
} from "@/components/payment/Icons";
import {
  cn,
  formatAmount,
  mapBackendErrorMessage,
  normalizePhone,
} from "@/components/payment/helpers";
import {
  PaymentMethod,
  PaymentStatus,
} from "@/components/payment/types";

type ApiResponse = {
  success?: boolean;
  status?: "confirm_required" | "success" | "failed" | "pending" | "pending_payment" | "payment_confirmed";
  reason?: "user_cancelled" | "timeout" | "error";
  message?: string;
  transactionId?: string;
  error?: string;
  battery_id?: string;
  slot_id?: string;
  waafiMessage?: string;
};

type PaymentStep = {
  id: string;
  label: string;
  somaliLabel: string;
  status: "pending" | "active" | "completed" | "failed";
};

function parseMethod(value: string | null): PaymentMethod {
  if (value && PAYMENT_METHODS.includes(value as PaymentMethod)) {
    return value as PaymentMethod;
  }
  return "EVC Plus";
}

function formatPhone(phoneNumber: string) {
  const cleaned = phoneNumber.replace(/\D/g, "");
  if (!cleaned) {
    return "--";
  }
  if (cleaned.startsWith("252")) {
    return `+${cleaned}`;
  }
  return `+252${cleaned}`;
}

export function PaymentProcessingPage() {
  const searchParams = useSearchParams();
  const paymentRequestAbortRef = useRef<AbortController | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollingStartedAtRef = useRef<number | null>(null);
  const pollingRequestInFlightRef = useRef(false);

  const method = useMemo(
    () => parseMethod(searchParams.get("method")),
    [searchParams],
  );
  const amount = useMemo(() => {
    const raw = Number(searchParams.get("amount"));
    return Number.isFinite(raw) && raw > 0 ? raw : 0.5;
  }, [searchParams]);

  const phoneNumber = useMemo(
    () => normalizePhone(searchParams.get("phone") || ""),
    [searchParams],
  );
  const stationCode = useMemo(
    () => normalizePhone(searchParams.get("stationCode") || ""),
    [searchParams],
  );
  const idempotencyKey = useMemo(
    () => (searchParams.get("idempotencyKey") || "").trim(),
    [searchParams],
  );

  const [status, setStatus] = useState<PaymentStatus>("CONNECTING");
  const [errorMessage, setErrorMessage] = useState("");
  const [transactionId, setTransactionId] = useState("");
  const [failureReason, setFailureReason] = useState<ApiResponse["reason"]>();
  const [isPollingTimeout, setIsPollingTimeout] = useState(false);
  const [batteryInfo, setBatteryInfo] = useState<{
    batteryId: string;
    slotId: string;
  } | null>(null);
  const [steps, setSteps] = useState<PaymentStep[]>([
    { id: "init", label: "Payment initiated", somaliLabel: "Lacag bixinta waa la bilaabay", status: "pending" },
    { id: "pending", label: "Waiting for PIN on your phone", somaliLabel: "Fadlan dhammee PIN-ka taleefankaaga", status: "pending" },
    { id: "confirmed", label: "Payment confirmed", somaliLabel: "Lacagta waa la xaqiijiyay", status: "pending" },
    { id: "unlocking", label: "Releasing power bank", somaliLabel: "Sii deynta power bank-ga", status: "pending" },
    { id: "verifying", label: "Verifying", somaliLabel: "Hubinta inuu si sax ah u soo baxay", status: "pending" },
    { id: "success", label: "Power bank ready", somaliLabel: "Power Bank Waa Diyaar", status: "pending" },
  ]);

  const updateStepStatus = (stepId: string, newStatus: PaymentStep["status"]) => {
    setSteps(prev => prev.map(step =>
      step.id === stepId ? { ...step, status: newStatus } : step
    ));
  };

  const getFriendlyFailureMessage = (
    reason?: ApiResponse["reason"],
    backendError?: string,
  ) => {
    if (reason === "user_cancelled") {
      return "Waad joojisay bixinta. Lacag lagama jarin. Payment cancelled. No money charged.";
    }

    if (reason === "timeout") {
      return "Lacag bixin wali ma dhicin. Fadlan sug wax yar ama mar kale isku day. Payment is still being verified.";
    }

    const normalizedError = String(backendError || "").toLowerCase();

    if (
      normalizedError.includes("insufficient") ||
      normalizedError.includes("low balance") ||
      normalizedError.includes("not enough balance") ||
      normalizedError.includes("haraaga")
    ) {
      return "Lacag kugu filan ma jirto. Fadlan hubi haraagaga ama lambarka aad bixinta ka isticmaaleyso, kadibna mar kale isku day. Insufficient balance.";
    }

    if (
      normalizedError.includes("payment not approved") ||
      normalizedError.includes("payment hold not approved") ||
      normalizedError.includes("not approved") ||
      normalizedError.includes("declined") ||
      normalizedError.includes("rejected")
    ) {
      return "Bixinta lama oggolaan. Fadlan hubi haraagaga ama lambarka, kadibna mar kale isku day. Payment was not approved.";
    }

    if (
      normalizedError.includes("wrong pin") ||
      normalizedError.includes("invalid pin") ||
      normalizedError.includes("pin")
    ) {
      return "PIN-ka aad gelisay ma saxna ama lama xaqiijin. Fadlan hubi PIN-ka oo mar kale isku day.";
    }

    if (
      normalizedError.includes("number") ||
      normalizedError.includes("phone") ||
      normalizedError.includes("accountno") ||
      normalizedError.includes("account no")
    ) {
      return "Lambarka bixinta waa khaldan yahay ama lama aqoonsan. Fadlan hubi lambarka oo mar kale isku day.";
    }

    if (backendError) {
      const mapped = mapBackendErrorMessage(backendError);
      if (mapped && mapped.trim().length > 0 && !mapped.toLowerCase().includes("khalad")) {
        return mapped;
      }
    }

    return "Lacag bixin ma dhicin. Lacag lagama jarin. Fadlan mar kale isku day. Payment did not complete. No money charged. Please try again.";
  };

  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    pollingRequestInFlightRef.current = false;
  };

  useEffect(() => {
    if (!phoneNumber || !idempotencyKey) {
      setStatus("FAILED");
      setErrorMessage("Macluumaad sax ah lama helin. Fadlan mar kale isku day.");
      return;
    }

    let isCancelled = false;

    const runPayment = async () => {
      setStatus("CONNECTING");
      updateStepStatus("init", "active");

      try {
        const controller = new AbortController();
        paymentRequestAbortRef.current = controller;

        const response = await fetch("/api/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            phoneNumber,
            amount,
            stationCode,
            idempotencyKey,
          }),
        });

        if (isCancelled) return;

        const data: ApiResponse = await response.json();

        updateStepStatus("init", "completed");

        if (data.status === "pending") {
          setTransactionId(data.transactionId || idempotencyKey);
          updateStepStatus("pending", "active");
          setIsPollingTimeout(false);
          setFailureReason(undefined);
          console.info("PAYMENT_PENDING_STARTED", {
            transactionId: data.transactionId || idempotencyKey,
          });
          setStatus("PENDING");
          return;
        }

        if (data.status === "confirm_required") {
          setTransactionId(data.transactionId || idempotencyKey);
          updateStepStatus("confirmed", "completed");
          updateStepStatus("unlocking", "completed");
          updateStepStatus("verifying", "active");
          setStatus("CONFIRM_REQUIRED");
          return;
        }

        if (response.ok && (data.success || data.status === "success")) {
          updateStepStatus("confirmed", "completed");
          updateStepStatus("unlocking", "completed");
          updateStepStatus("verifying", "completed");
          updateStepStatus("success", "completed");
          setBatteryInfo(
            data.battery_id && data.slot_id
              ? { batteryId: data.battery_id, slotId: data.slot_id }
              : null
          );
          setStatus("SUCCESS");
          stopPolling();
        } else {
          setStatus("FAILED");
          setErrorMessage(getFriendlyFailureMessage(data.reason, data.error));
          updateStepStatus("confirmed", "failed");
          stopPolling();
        }
      } catch (error) {
        if (!isCancelled) {
          setStatus("FAILED");
          setErrorMessage(error instanceof Error ? error.message : "Cillad farsamo ayaa dhacday.");
          updateStepStatus("init", "failed");
        }
      }
    };

    runPayment();

    return () => {
      isCancelled = true;
      paymentRequestAbortRef.current?.abort();
      if (pollingIntervalRef.current) {
        stopPolling();
      }
    };
  }, [amount, idempotencyKey, phoneNumber, stationCode]);

  useEffect(() => {
    if (status !== "PENDING" || !transactionId) {
      return;
    }

    pollingStartedAtRef.current = Date.now();
    setIsPollingTimeout(false);

    const poll = async () => {
      if (pollingRequestInFlightRef.current) {
        return;
      }

      const startedAt = pollingStartedAtRef.current || Date.now();
      if (Date.now() - startedAt >= 60_000) {
        stopPolling();
        setIsPollingTimeout(true);
        console.info("PAYMENT_TIMEOUT", { transactionId });
        return;
      }

      pollingRequestInFlightRef.current = true;

      try {
        const response = await fetch(`/api/payment/status?transactionId=${transactionId}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }

        const data: ApiResponse = await response.json();

        if (data.status === "payment_confirmed") {
          updateStepStatus("confirmed", "completed");
          updateStepStatus("unlocking", "completed");
          updateStepStatus("verifying", "completed");
          updateStepStatus("success", "completed");
          if (data.battery_id && data.slot_id) {
            setBatteryInfo({ batteryId: data.battery_id, slotId: data.slot_id });
          }
          setIsPollingTimeout(false);
          console.info("PAYMENT_CONFIRMED", { transactionId });
          setStatus("SUCCESS");
          stopPolling();
          return;
        }

        if (data.status === "failed") {
          setFailureReason(data.reason);
          if (data.reason === "user_cancelled") {
            setErrorMessage(getFriendlyFailureMessage(data.reason, data.error));
            console.info("PAYMENT_USER_CANCELLED", { transactionId });
          } else {
            setErrorMessage(getFriendlyFailureMessage(data.reason, data.error));
            console.info("PAYMENT_FAILED", { transactionId, reason: data.reason || "unknown" });
          }
          updateStepStatus("confirmed", "failed");
          setIsPollingTimeout(false);
          setStatus("FAILED");
          stopPolling();
        }
      } catch {
        // Keep polling on transient network failure.
      } finally {
        pollingRequestInFlightRef.current = false;
      }
    };

    void poll();
    pollingIntervalRef.current = setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      stopPolling();
    };
  }, [status, transactionId]);

  const handleConfirm = async (confirmed: boolean) => {
    try {
      setStatus(confirmed ? "SUCCESS" : "FAILED");

      const res = await fetch("/api/pay/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionId,
          confirmed: confirmed
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setStatus("FAILED");
        setErrorMessage(data.error || "Xaqiijinta waa fashilantay.");
        return;
      }

      if (confirmed) {
        setStatus("SUCCESS");
        if (data.battery_id) {
          setBatteryInfo({
            batteryId: data.battery_id,
            slotId: data.slot_id
          });
        }
      } else {
        setStatus("FAILED");
        setErrorMessage("Waad mahadsantahay. Hold-ka lacagta waa la joojiyay.");
      }
    } catch (error) {
      setStatus("FAILED");
      setErrorMessage("Cillad farsamo ayaa dhacday inta lagu guda jiray xaqiijinta.");
    }
  };

  const renderStepIcon = (stepStatus: PaymentStep["status"]) => {
    switch (stepStatus) {
      case "completed":
        return <CheckIcon className="h-4 w-4 text-emerald-600" />;
      case "active":
        return <ClockIcon className="h-4 w-4 text-blue-600 animate-pulse" />;
      case "failed":
        return <CloseIcon className="h-4 w-4 text-red-600" />;
      default:
        return <div className="h-4 w-4 rounded-full border-2 border-gray-300" />;
    }
  };

  const renderContent = () => {
    switch (status) {
      case "CONNECTING":
        return (
          <div className="space-y-6 py-4">
            <div className="text-center">
              <p className="text-xs uppercase tracking-widest text-slate-400 mb-3">
                {method} • {formatAmount(amount)} • {formatPhone(phoneNumber)}
              </p>
              <div className="flex justify-center mb-4">
                <div className="relative h-16 w-16">
                  <div className="absolute inset-0 animate-ping rounded-full bg-violet-400/20" />
                  <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-white shadow-xl">
                    <span className="h-8 w-8 animate-spin rounded-full border-4 border-violet-500 border-t-transparent" />
                  </div>
                </div>
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                Starting payment process...
              </h1>
              <p className="text-sm text-slate-600">
                Lacag bixinta waa la bilaabay...
              </p>
            </div>

            {/* Step Progress */}
            <div className="space-y-3">
              {steps.map((step, index) => (
                <div key={step.id} className="flex items-center gap-3">
                  <div className="flex-shrink-0">
                    {renderStepIcon(step.status)}
                  </div>
                  <div className="flex-1 text-left">
                    <p className={cn(
                      "text-sm font-medium",
                      step.status === "active" ? "text-blue-700" :
                        step.status === "completed" ? "text-emerald-700" :
                          step.status === "failed" ? "text-red-700" : "text-gray-500"
                    )}>
                      {step.label}
                    </p>
                    <p className={cn(
                      "text-xs",
                      step.status === "active" ? "text-blue-600" :
                        step.status === "completed" ? "text-emerald-600" :
                          step.status === "failed" ? "text-red-600" : "text-gray-400"
                    )}>
                      {step.somaliLabel}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );

      case "PENDING":
        return (
          <div className="space-y-6 py-4">
            <div className="text-center">
              <p className="text-xs uppercase tracking-widest text-slate-400 mb-3">
                {method} • {formatAmount(amount)} • {formatPhone(phoneNumber)}
              </p>
              <div className="flex justify-center mb-4">
                <div className="relative h-16 w-16">
                  <div className="absolute inset-0 animate-ping rounded-full bg-blue-400/20" />
                  <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-white shadow-xl">
                    <span className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
                  </div>
                </div>
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                Fadlan dhammee PIN-ka taleefankaaga
              </h1>
              <p className="text-sm text-slate-600 mb-4">
                Please complete payment on your phone
              </p>
              <div className="rounded-xl bg-blue-50 p-4 border border-blue-100">
                <p className="text-sm font-medium text-blue-700">
                  Waxaan sugaynaa xaqiijinta bixinta.
                </p>
              </div>
              {isPollingTimeout && (
                <div className="mt-4 rounded-xl bg-amber-50 p-4 border border-amber-100">
                  <p className="text-sm font-medium text-amber-700">
                    Waxaan wali hubinaynaa lacagta. Fadlan sug.
                  </p>
                  <p className="text-xs text-amber-600 mt-1">
                    We are still verifying your payment.
                  </p>
                </div>
              )}
            </div>

            {/* Step Progress */}
            <div className="space-y-3">
              {steps.map((step, index) => (
                <div key={step.id} className="flex items-center gap-3">
                  <div className="flex-shrink-0">
                    {renderStepIcon(step.status)}
                  </div>
                  <div className="flex-1 text-left">
                    <p className={cn(
                      "text-sm font-medium",
                      step.status === "active" ? "text-blue-700" :
                        step.status === "completed" ? "text-emerald-700" :
                          step.status === "failed" ? "text-red-700" : "text-gray-500"
                    )}>
                      {step.label}
                    </p>
                    <p className={cn(
                      "text-xs",
                      step.status === "active" ? "text-blue-600" :
                        step.status === "completed" ? "text-emerald-600" :
                          step.status === "failed" ? "text-red-600" : "text-gray-400"
                    )}>
                      {step.somaliLabel}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-xl bg-slate-50 p-4 border border-slate-100">
              <p className="text-sm text-slate-500">
                Money Status: <span className="font-bold text-slate-700">PENDING</span>
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Lacagta lama jarin weli. Waxaan sugaynaa jawaabta bixinta ee provider-ka.
              </p>
            </div>
          </div>
        );

      case "CONFIRM_REQUIRED":
        return (
          <div className="space-y-6 py-4">
            <div className="text-center">
              <div className="flex justify-center mb-4">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100">
                  <HelpCircleIcon className="h-8 w-8 text-amber-600" />
                </div>
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                Power bank ma soo baxay?
              </h1>
              <p className="text-sm text-slate-600 mb-4">
                Waxaan rabnaa inaad lacag bixiso kaliya marka aad hesho.
              </p>
              <p className="text-xs text-slate-500">
                Did the power bank come out?
              </p>
            </div>

            {/* Step Progress */}
            <div className="space-y-3 mb-6">
              {steps.map((step, index) => (
                <div key={step.id} className="flex items-center gap-3">
                  <div className="flex-shrink-0">
                    {renderStepIcon(step.status)}
                  </div>
                  <div className="flex-1 text-left">
                    <p className={cn(
                      "text-sm font-medium",
                      step.status === "active" ? "text-amber-700" :
                        step.status === "completed" ? "text-emerald-700" :
                          step.status === "failed" ? "text-red-700" : "text-gray-500"
                    )}>
                      {step.label}
                    </p>
                    <p className={cn(
                      "text-xs",
                      step.status === "active" ? "text-amber-600" :
                        step.status === "completed" ? "text-emerald-600" :
                          step.status === "failed" ? "text-red-600" : "text-gray-400"
                    )}>
                      {step.somaliLabel}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-3">
              <button
                onClick={() => handleConfirm(true)}
                className="flex w-full items-center justify-center rounded-2xl bg-emerald-500 px-6 py-4 text-lg font-bold text-white shadow-lg hover:bg-emerald-600 active:scale-95"
              >
                Haa, waan helay
              </button>
              <button
                onClick={() => handleConfirm(false)}
                className="flex w-full items-center justify-center rounded-2xl bg-white border-2 border-slate-200 px-6 py-4 text-lg font-bold text-slate-600 hover:bg-slate-50 active:scale-95"
              >
                Maya, ma soo bixin
              </button>
            </div>
          </div>
        );

      case "SUCCESS":
        return (
          <div className="space-y-6 py-4">
            <div className="text-center">
              <div className="flex justify-center mb-4">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 shadow-inner">
                  <CheckIcon className="h-8 w-8 text-emerald-600" />
                </div>
              </div>
              <h1 className="text-2xl font-bold text-slate-900 mb-2">
                Power Bank Waa Diyaar
              </h1>
              <p className="text-sm text-slate-600 mb-4">
                Power bank-gaaga si guul leh ayuu u soo baxay.
              </p>
              <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-4 shadow-sm">
                <p className="text-lg font-bold text-emerald-800">
                  Fadlan ka qaado qalabka
                </p>
                {batteryInfo && (
                  <p className="mt-2 text-sm text-emerald-600 font-medium">
                    Slot: {batteryInfo.slotId} • ID: {batteryInfo.batteryId}
                  </p>
                )}
              </div>
            </div>

            {/* Step Progress */}
            <div className="space-y-3">
              {steps.map((step, index) => (
                <div key={step.id} className="flex items-center gap-3">
                  <div className="flex-shrink-0">
                    {renderStepIcon(step.status)}
                  </div>
                  <div className="flex-1 text-left">
                    <p className={cn(
                      "text-sm font-medium",
                      step.status === "active" ? "text-emerald-700" :
                        step.status === "completed" ? "text-emerald-700" :
                          step.status === "failed" ? "text-red-700" : "text-gray-500"
                    )}>
                      {step.label}
                    </p>
                    <p className={cn(
                      "text-xs",
                      step.status === "active" ? "text-emerald-600" :
                        step.status === "completed" ? "text-emerald-600" :
                          step.status === "failed" ? "text-red-600" : "text-gray-400"
                    )}>
                      {step.somaliLabel}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <Link
              href="/"
              className="group flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 px-6 py-4 text-lg font-bold text-white transition-all hover:bg-slate-800"
            >
              Finish
              <ArrowRightIcon className="h-5 w-5 transition-transform group-hover:translate-x-1" />
            </Link>
          </div>
        );

      case "FAILED":
        return (
          <div className="space-y-6 py-4">
            <div className="text-center">
              <div className="flex justify-center mb-4">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-rose-100">
                  <CloseIcon className="h-8 w-8 text-rose-600" />
                </div>
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                {failureReason === "user_cancelled"
                  ? "Bixinta waa la joojiyay"
                  : "Lacag bixinta ma dhicin"}
              </h1>
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
                <p className="text-sm font-medium text-rose-700">
                  {errorMessage || "Cillad farsamo ayaa dhacday."}
                </p>
              </div>
            </div>

            {/* Step Progress */}
            <div className="space-y-3">
              {steps.map((step, index) => (
                <div key={step.id} className="flex items-center gap-3">
                  <div className="flex-shrink-0">
                    {renderStepIcon(step.status)}
                  </div>
                  <div className="flex-1 text-left">
                    <p className={cn(
                      "text-sm font-medium",
                      step.status === "active" ? "text-red-700" :
                        step.status === "completed" ? "text-emerald-700" :
                          step.status === "failed" ? "text-red-700" : "text-gray-500"
                    )}>
                      {step.label}
                    </p>
                    <p className={cn(
                      "text-xs",
                      step.status === "active" ? "text-red-600" :
                        step.status === "completed" ? "text-emerald-600" :
                          step.status === "failed" ? "text-red-600" : "text-gray-400"
                    )}>
                      {step.somaliLabel}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {failureReason === "user_cancelled" && (
              <div className="rounded-xl bg-emerald-50 p-4 border border-emerald-100">
                <p className="text-sm font-bold text-emerald-700">
                  Waad joojisay bixinta. Lacag lagama jarin.
                </p>
                <p className="text-xs text-emerald-600 mt-1">
                  Payment cancelled. No money charged.
                </p>
              </div>
            )}

            <Link
              href="/"
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 px-6 py-4 text-lg font-bold text-white hover:bg-slate-800"
            >
              Dib u isku day
            </Link>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4 bg-[#f8fafc]">
      {/* Background Ornaments */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-violet-100/50 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-emerald-100/50 blur-[120px]" />
      </div>

      <div className="relative w-full max-w-md">
        <main className="overflow-hidden rounded-[32px] border border-white bg-white/80 p-6 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.14)] backdrop-blur-2xl">
          {renderContent()}
        </main>

        <p className="mt-8 text-center text-xs font-semibold text-slate-400 uppercase tracking-widest">
          Danab Smart Ejection System v2.0
        </p>
      </div>
    </div>
  );
}
