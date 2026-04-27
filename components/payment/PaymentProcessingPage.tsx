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
  normalizePhone,
} from "@/components/payment/helpers";
import {
  PaymentMethod,
  PaymentStatus,
} from "@/components/payment/types";

type ApiResponse = {
  status?:
  | "pending_payment"
  | "held"
  | "paid"
  | "processing"
  | "verifying"
  | "verified"
  | "confirm_required"
  | "partial_success"
  | "captured"
  | "failed";
  reason_code?:
  | "USER_CANCELLED"
  | "INSUFFICIENT_FUNDS"
  | "INSUFFICIENT_BALANCE"
  | "PROVIDER_DECLINED"
  | "PROVIDER_ERROR"
  | "WRONG_PIN"
  | "TIMEOUT"
  | "UNLOCK_FAILED"
  | "UNLOCK_TIMEOUT"
  | "VERIFICATION_FAILED"
  | "SLA_BREACH"
  | "INVALID_INITIAL_STATE"
  | "STATION_OFFLINE";
  stage?: "payment" | "unlock" | "verification" | "capture" | "system";
  providerRef?: string | null;
  message?: string;
  transactionId?: string;
  error?: string;
  battery_id?: string;
  slot_id?: string;
  waafiMessage?: string;
  unlockStarted?: boolean;
  recovered?: boolean;
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
  const [failureReason, setFailureReason] = useState<ApiResponse["reason_code"]>();
  const [failureStage, setFailureStage] = useState<ApiResponse["stage"]>();
  const [isRecovered, setIsRecovered] = useState(false);
  const [isSlowPolling, setIsSlowPolling] = useState(false);
  const [batteryInfo, setBatteryInfo] = useState<{
    batteryId: string;
    slotId: string;
  } | null>(null);
  const [steps, setSteps] = useState<PaymentStep[]>([
    { id: "init", label: "Payment initiated", somaliLabel: "Lacag bixinta waa la bilaabay", status: "pending" },
    { id: "pending", label: "Waiting for PIN on your phone", somaliLabel: "Fadlan dhammee PIN-ka taleefankaaga", status: "pending" },
    { id: "confirmed", label: "Payment confirmed", somaliLabel: "Lacagta waxaa lagu hayaa hold", status: "pending" },
    { id: "unlocking", label: "Releasing power bank", somaliLabel: "Sii deynta power bank-ga", status: "pending" },
    { id: "verifying", label: "Verifying", somaliLabel: "Hubinta inuu si sax ah u soo baxay", status: "pending" },
    { id: "success", label: "Power bank ready", somaliLabel: "Power Bank Waa Diyaar", status: "pending" },
  ]);

  const updateStepStatus = (stepId: string, newStatus: PaymentStep["status"]) => {
    setSteps(prev => prev.map(step =>
      step.id === stepId ? { ...step, status: newStatus } : step
    ));
  };

  // normalizeFailureReason REMOVED — frontend trusts backend reason_code directly

  const getFriendlyFailureMessage = (
    reason?: ApiResponse["reason_code"],
    stage?: ApiResponse["stage"],
  ) => {
    // Stage-aware: unlock failures mean payment succeeded but device failed
    if (stage === "unlock") {
      if (reason === "UNLOCK_FAILED" || reason === "UNLOCK_TIMEOUT") {
        return "Lacagta waa la xaqiijiyay laakiin qalad ayaa ka dhacay bixinta power bank-ka. Lacagta waa laguu soo celin doonaa.";
      }
      if (reason === "INVALID_INITIAL_STATE") {
        return "Qalabka slot-kiisu uma diyaarnayn. Lacagta waa laguu soo celin doonaa.";
      }
      return "Bixinta qalabka way fashilantay. Lacagta waa laguu soo celin doonaa.";
    }
    if (stage === "verification") {
      return "Waxaan xaqiijin kari waynay in qalabku soo baxay. Lacagta waa laguu soo celin doonaa.";
    }
    if (stage === "capture") {
      return "Lacag qaadashadu way fashilantay. Fadlan la xiriir taageerada.";
    }

    // Payment-stage failures (by reason)
    if (reason === "USER_CANCELLED") {
      return "Waad joojisay lacag bixinta. You cancelled the payment.";
    }
    if (reason === "INSUFFICIENT_FUNDS" || reason === "INSUFFICIENT_BALANCE") {
      return "Haraagaagu kuma filna. Fadlan lacag ku dar oo isku day mar kale.";
    }
    if (reason === "PROVIDER_DECLINED" || reason === "WRONG_PIN") {
      return "Lacag bixinta waa la diiday. Fadlan hubi PIN-kaaga ama in akoonkaagu xanniban yahay.";
    }
    if (reason === "TIMEOUT") {
      return "Waqtiga lacag bixintu wuu dhammaaday. Payment request timed out.";
    }
    if (reason === "PROVIDER_ERROR") {
      return "Waxaa dhacay cilad adeeg bixiyaha. There was an issue with the payment provider.";
    }
    if (reason === "SLA_BREACH") {
      return "Lacag bixinta waxay qaadatay waqti dheer. Fadlan la xiriir taageerada macaamiisha.";
    }
    if (reason === "STATION_OFFLINE") {
      return "Station-kaan hadda ma shaqeynayo. Fadlan tijaabi mid kale.";
    }

    return "Wax khalad ah ayaa dhacay, fadlan mar kale isku day. Something went wrong, please try again.";
  };

  const getFailureHeading = (
    reason?: ApiResponse["reason_code"],
    stage?: ApiResponse["stage"],
  ) => {
    // Stage-aware headings
    if (stage === "unlock") {
      return "Lacagtii waa la xaqiijiyay, laakiin power bank-ga lama sii deyn karin";
    }
    if (stage === "verification") {
      return "Xaqiijinta qalabka ayaa fashilantay";
    }
    if (stage === "capture") {
      return "Lacag qaadashada waa fashilantay";
    }

    // Payment-stage headings
    if (reason === "USER_CANCELLED") {
      return "Bixinta waa la joojiyay";
    }

    if (reason === "INSUFFICIENT_FUNDS" || reason === "INSUFFICIENT_BALANCE") {
      return "Haraaga kuma filna";
    }

    if (reason === "PROVIDER_DECLINED" || reason === "WRONG_PIN") {
      return "Lacag bixinta waa la diiday";
    }

    if (reason === "TIMEOUT") {
      return "Xaqiijinta lacagta way daahday";
    }

    if (reason === "UNLOCK_TIMEOUT") {
      return "Soo deynta qalabka ayaa qaadatay wakhti xad dhaaf ah";
    }

    if (reason === "UNLOCK_FAILED") {
      return "Lacagtii waa la xaqiijiyay, laakiin power bank-ga lama sii deyn karin";
    }

    if (reason === "VERIFICATION_FAILED") {
      return "Xaqiijinta qalabka ayaa fashilantay";
    }

    if (reason === "INVALID_INITIAL_STATE") {
      return "Slot state invalid before unlock";
    }

    if (reason === "PROVIDER_ERROR") {
      return "Cilad adeeg bixiyaha";
    }

    if (reason === "STATION_OFFLINE") {
      return "Station-ka waa offline";
    }

    return "Lacag bixinta ma dhicin";
  };

  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    pollingRequestInFlightRef.current = false;
  };

  const transactionStorageKey = useMemo(
    () => (idempotencyKey ? `paymentTransactionId:${idempotencyKey}` : null),
    [idempotencyKey],
  );

  const [hasLoadedStoredTransactionId, setHasLoadedStoredTransactionId] = useState(false);

  useEffect(() => {
    if (!transactionStorageKey || transactionId) {
      setHasLoadedStoredTransactionId(true);
      return;
    }

    try {
      const savedId = window.localStorage.getItem(transactionStorageKey);
      if (savedId) {
        setTransactionId(savedId);
      }
    } catch {
      // Ignore storage failures
    } finally {
      setHasLoadedStoredTransactionId(true);
    }
  }, [transactionStorageKey, transactionId]);

  useEffect(() => {
    if (!transactionStorageKey) {
      return;
    }

    try {
      if (transactionId) {
        window.localStorage.setItem(transactionStorageKey, transactionId);
      } else {
        window.localStorage.removeItem(transactionStorageKey);
      }
    } catch {
      // Ignore storage failures
    }
  }, [transactionStorageKey, transactionId]);

  const executeUnlock = async () => {
    if (!transactionId) {
      return false;
    }

    try {
      const response = await fetch("/api/payment/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId }),
      });

      const data: ApiResponse = await response.json();
      console.info("PAYMENT_EXECUTE_RESPONSE", { transactionId, status: data.status, unlockStarted: data.unlockStarted });

      if (!response.ok || data.status === "failed") {
        if (data.status === "failed" || data.status === "partial_success") {
          const reason = data.reason_code;
          setFailureReason(reason);
          setFailureStage(data.stage);
          setErrorMessage(getFriendlyFailureMessage(reason, data.stage));
          setStatus(data.status === "partial_success" ? "PARTIAL_SUCCESS" : "FAILED");
          updateStepStatus("confirmed", "failed");
        }
        return false;
      }

      if (data.status === "processing") {
        updateStepStatus("pending", "completed");
        updateStepStatus("confirmed", "completed");
        updateStepStatus("unlocking", "active");
        setStatus("PROCESSING");
        return true;
      }

      if (data.status === "verifying") {
        updateStepStatus("pending", "completed");
        updateStepStatus("confirmed", "completed");
        updateStepStatus("unlocking", "completed");
        updateStepStatus("verifying", "active");
        setStatus("PROCESSING");
        return true;
      }

      if (data.status === "verified") {
        updateStepStatus("confirmed", "completed");
        updateStepStatus("unlocking", "completed");
        updateStepStatus("verifying", "completed");
        updateStepStatus("success", "completed");
        setStatus("SUCCESS");
        return true;
      }

      return true;
    } catch (error) {
      console.warn("PAYMENT_EXECUTE_REQUEST_FAILED", { transactionId, error });
      return false;
    }
  };

  useEffect(() => {
    if (status === "WAITING_PIN") {
      updateStepStatus("pending", "active");
    }

    if (status === "PROCESSING") {
      updateStepStatus("pending", "completed");
      updateStepStatus("confirmed", "active");
    }

    if (status === "SUCCESS") {
      updateStepStatus("confirmed", "completed");
      updateStepStatus("success", "completed");
    }

    if (status === "FAILED") {
      setSteps((currentSteps) => {
        const activeIndex = currentSteps.findIndex((step) => step.status === "active");
        const pendingIndex = currentSteps.findIndex((step) => step.status === "pending");
        const failureIndex = activeIndex !== -1 ? activeIndex : pendingIndex !== -1 ? pendingIndex : 0;

        return currentSteps.map((step, index) => {
          if (index < failureIndex) {
            return { ...step, status: "completed" };
          }

          if (index === failureIndex) {
            return { ...step, status: "failed" };
          }

          return { ...step, status: "pending" };
        });
      });
    }
  }, [status]);

  useEffect(() => {
    if (!phoneNumber || !idempotencyKey) {
      setStatus("FAILED");
      setFailureReason("PROVIDER_ERROR");
      setErrorMessage("Macluumaad sax ah lama helin. Fadlan mar kale isku day.");
      return;
    }

    if (transactionId || !hasLoadedStoredTransactionId) {
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
        console.log("PAY RESPONSE:", data);
        console.log("REASON CODE:", data.reason_code);

        if (data.status === "failed" || !response.ok) {
          const reason = data.reason_code;
          setStatus("FAILED");
          setFailureReason(reason);
          setFailureStage(data.stage);
          setErrorMessage(data.error || getFriendlyFailureMessage(reason, data.stage));
          updateStepStatus("init", "failed");
          return;
        }

        updateStepStatus("init", "completed");
        setTransactionId(data.transactionId || idempotencyKey);

        if (data.status === "held") {
          updateStepStatus("pending", "completed");
          updateStepStatus("confirmed", "completed");
          updateStepStatus("unlocking", "active");
          setStatus("PROCESSING");
        } else {
          updateStepStatus("pending", "active");
          setStatus(data.providerRef ? "WAITING_PIN" : "PENDING_PAYMENT");
        }
        console.info("PAYMENT_PENDING_STARTED", {
          transactionId: data.transactionId || idempotencyKey,
          providerEngaged: Boolean(data.providerRef),
        });
      } catch (error) {
        if (!isCancelled) {
          setStatus("FAILED");
          setFailureReason("PROVIDER_ERROR");
          setErrorMessage(getFriendlyFailureMessage("PROVIDER_ERROR", "payment"));
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
  }, [amount, idempotencyKey, phoneNumber, stationCode, transactionId, hasLoadedStoredTransactionId]);

  useEffect(() => {
    if (!transactionId || status === "SUCCESS" || status === "FAILED") {
      return;
    }

    pollingStartedAtRef.current = Date.now();
    setIsSlowPolling(false);

    const poll = async () => {
      if (pollingRequestInFlightRef.current) {
        return;
      }

      const startedAt = pollingStartedAtRef.current || Date.now();
      const elapsedMs = Date.now() - startedAt;
      setIsSlowPolling(elapsedMs >= 60_000);

      pollingRequestInFlightRef.current = true;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

        const response = await fetch(`/api/payment/status?transactionId=${transactionId}`, {
          cache: "no-store",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          return;
        }

        const data: ApiResponse = await response.json();
        console.log("STATUS RESPONSE:", data);
        console.log("REASON CODE:", data.reason_code);

        if (data.status === "held" || data.status === "paid") {
          setIsRecovered(data.recovered || false);
          updateStepStatus("pending", "completed");
          updateStepStatus("confirmed", "completed");
          updateStepStatus("unlocking", "active");
          setStatus("PROCESSING");
          const executed = await executeUnlock();
          if (!executed) {
            console.info("PAYMENT_EXECUTE_RETRY_SCHEDULED", { transactionId });
          }
          return;
        }

        if (data.status === "processing") {
          setIsRecovered(data.recovered || false);
          updateStepStatus("pending", "completed");
          updateStepStatus("confirmed", "completed");
          updateStepStatus("unlocking", "active");
          setStatus("PROCESSING");
          return;
        }

        if (data.stage === "verification") {
          updateStepStatus("unlocking", "completed");
          updateStepStatus("verifying", "active");
        } else if (data.stage === "unlock") {
          updateStepStatus("confirmed", "completed");
          updateStepStatus("unlocking", "active");
        } else if (data.stage === "capture") {
          updateStepStatus("verifying", "completed");
          updateStepStatus("success", "active");
        }

        if (data.status === "verified" || data.status === "captured") {
          setIsRecovered(data.recovered || false);
          updateStepStatus("pending", "completed");
          updateStepStatus("confirmed", "completed");
          updateStepStatus("unlocking", "completed");
          updateStepStatus("verifying", "completed");
          updateStepStatus("success", "completed");
          setBatteryInfo({ batteryId: data.battery_id || "", slotId: data.slot_id || "" });
          setIsSlowPolling(false);
          console.info("PAYMENT_VERIFIED", { transactionId });
          setStatus("SUCCESS");
          stopPolling();
          return;
        }

        if (data.status === "partial_success") {
          setIsRecovered(data.recovered || false);
          const reason = data.reason_code;
          setFailureReason(reason);
          setFailureStage(data.stage);
          setErrorMessage(getFriendlyFailureMessage(reason, data.stage));
          setIsSlowPolling(false);
          setStatus("PARTIAL_SUCCESS");
          stopPolling();
          return;
        }

        if (data.status === "failed") {
          const reason = data.reason_code;
          setFailureReason(reason);
          setFailureStage(data.stage);
          setErrorMessage(getFriendlyFailureMessage(reason, data.stage));
          if (reason === "USER_CANCELLED") {
            console.info("PAYMENT_USER_CANCELLED", { transactionId });
          } else {
            console.info("PAYMENT_FAILED", { transactionId, reason: reason || "unknown" });
          }
          updateStepStatus("confirmed", "failed");
          setIsSlowPolling(false);
          setStatus("FAILED");
          stopPolling();
          return;
        }

        // Continue polling for other states (pending_payment, etc.)
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          console.warn("PAYMENT_STATUS_REQUEST_TIMEOUT", { transactionId });
          // Continue polling on timeout
        } else {
          console.warn("PAYMENT_STATUS_REQUEST_ERROR", { transactionId, error });
          // Continue polling on other errors
        }
      } finally {
        pollingRequestInFlightRef.current = false;
      }
    };

    void poll();

    // Set interval based on polling phase
    const intervalMs = isSlowPolling ? 10000 : 2000; // 10s for slow polling, 2s for fast
    pollingIntervalRef.current = setInterval(() => {
      void poll();
    }, intervalMs);

    return () => {
      stopPolling();
    };
  }, [status, transactionId, isSlowPolling]);

  const handleConfirm = async (confirmed: boolean) => {
    try {
      setStatus("PROCESSING");

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
        setFailureReason("PROVIDER_ERROR");
        setErrorMessage(getFriendlyFailureMessage("PROVIDER_ERROR", "payment"));
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
        setFailureReason("USER_CANCELLED");
        setErrorMessage(getFriendlyFailureMessage("USER_CANCELLED", "payment"));
      }
    } catch (error) {
      setStatus("FAILED");
      setFailureReason("PROVIDER_ERROR");
      setErrorMessage(getFriendlyFailureMessage("PROVIDER_ERROR", "payment"));
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

      case "PENDING_PAYMENT":
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
              {isSlowPolling && (
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

      case "WAITING_PIN":
        return (
          <div className="space-y-6 py-4">
            <div className="text-center">
              <p className="text-xs uppercase tracking-widest text-slate-400 mb-3">
                {method} â€¢ {formatAmount(amount)} â€¢ {formatPhone(phoneNumber)}
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
                  Fadlan dhammee PIN-ka taleefankaaga
                </p>
                <p className="mt-1 text-xs text-blue-600">
                  Please complete payment on your phone
                </p>
              </div>
              {isSlowPolling && (
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
                Money Status: <span className="font-bold text-slate-700">WAITING FOR PIN</span>
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Lacagta lama jarin weli. Waxaan sugaynaa PIN-ka taleefankaaga.
              </p>
            </div>
          </div>
        );

      case "PROCESSING":
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
                Waxaan xaqiijinaynaa lacagta...
              </h1>
              <p className="text-sm text-slate-600 mb-4">
                Verifying payment and releasing power bank...
              </p>
              <div className="rounded-xl bg-violet-50 p-4 border border-violet-100">
                <p className="text-sm font-medium text-violet-700">
                  Waxaan hubinaynaa bixinta oo aan sii deynaynaa power bank-ga.
                </p>
              </div>
              {isSlowPolling && (
                <div className="mt-4 rounded-xl bg-amber-50 p-4 border border-amber-100 animate-pulse">
                  <p className="text-sm font-bold text-amber-800">
                    Arrintan waxay qaadanaysaa waqti ka badan intii la filayay...
                  </p>
                  <p className="text-xs text-amber-700 mt-1">
                    This is taking longer than expected. We are still working on it.
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
                      step.status === "active" ? "text-violet-700" :
                        step.status === "completed" ? "text-emerald-700" :
                          step.status === "failed" ? "text-red-700" : "text-gray-500"
                    )}>
                      {step.label}
                    </p>
                    <p className={cn(
                      "text-xs",
                      step.status === "active" ? "text-violet-600" :
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
                Money Status: <span className="font-bold text-violet-700">PROCESSING</span>
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Lacagta waa la xaqiijiyay. Waxaan sii deynaynaa power bank-ga.
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
              {isRecovered && (
                <div className="inline-block mt-1 mb-3 rounded-full bg-blue-100 px-4 py-1.5 border border-blue-200">
                  <p className="text-xs font-bold tracking-wide text-blue-700">
                    WE RECOVERED YOUR TRANSACTION
                  </p>
                </div>
              )}
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

      case "PARTIAL_SUCCESS":
        return (
          <div className="space-y-6 py-4">
            <div className="text-center">
              <div className="flex justify-center mb-4">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100">
                  <HelpCircleIcon className="h-8 w-8 text-amber-600" />
                </div>
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                {getFailureHeading(failureReason, failureStage)}
              </h1>
              {isRecovered && (
                <div className="inline-block mb-4 rounded-full bg-blue-100 px-4 py-1.5 border border-blue-200">
                  <p className="text-xs font-bold tracking-wide text-blue-700">
                    WE RECOVERED YOUR TRANSACTION
                  </p>
                </div>
              )}
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-700">
                  {errorMessage || "Lacagta waa la xaqiijiyay laakiin qalabka lama soo bixin."}
                </p>
                <p className="mt-2 text-xs text-amber-600">
                  Lacagta waa laguu soo celin doonaa si toos ah.
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
                      step.status === "completed" ? "text-emerald-700" :
                        step.status === "failed" ? "text-amber-700" : "text-gray-500"
                    )}>
                      {step.label}
                    </p>
                    <p className={cn(
                      "text-xs",
                      step.status === "completed" ? "text-emerald-600" :
                        step.status === "failed" ? "text-amber-600" : "text-gray-400"
                    )}>
                      {step.somaliLabel}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <Link
              href="/"
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 px-6 py-4 text-lg font-bold text-white hover:bg-slate-800"
            >
              Dib u isku day
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
                {getFailureHeading(failureReason, failureStage)}
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
