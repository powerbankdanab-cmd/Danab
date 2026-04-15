"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { PAYMENT_METHODS } from "@/components/payment/constants";
import { CheckIcon, CloseIcon } from "@/components/payment/Icons";
import {
  cn,
  mapBackendErrorMessage,
  normalizePhone,
} from "@/components/payment/helpers";
import {
  PaymentMethod,
  PaymentStatus,
  ProcessingStep,
} from "@/components/payment/types";

type ApiResponse = {
  success?: boolean;
  error?: string;
  blacklisted?: boolean;
  battery_id?: string;
  slot_id?: string;
  waafiMessage?: string;
  waafiMsg?: string;
};

const PROCESSING_STEPS: Array<{ key: ProcessingStep; label: string }> = [
  { key: "verify", label: "Hubinta" },
  { key: "hold", label: "Hold" },
  { key: "unlock", label: "Battery" },
  { key: "commit", label: "Commit" },
];

async function safeReadJson(response: Response): Promise<ApiResponse> {
  try {
    const data = (await response.json()) as ApiResponse;
    return data;
  } catch {
    return {};
  }
}

function formatAmount(amount: number) {
  return `$${amount.toFixed(2)}`;
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

function parseMethod(value: string | null): PaymentMethod {
  if (value && PAYMENT_METHODS.includes(value as PaymentMethod)) {
    return value as PaymentMethod;
  }

  return "EVC Plus";
}

export function PaymentProcessingPage() {
  const searchParams = useSearchParams();
  const paymentRequestAbortRef = useRef<AbortController | null>(null);

  const method = useMemo(
    () => parseMethod(searchParams.get("method")),
    [searchParams],
  );

  const amount = useMemo(() => {
    const raw = Number(searchParams.get("amount"));
    if (!Number.isFinite(raw) || raw <= 0) {
      return 0.5;
    }

    return raw;
  }, [searchParams]);

  const phoneNumber = useMemo(
    () => normalizePhone(searchParams.get("phone") || ""),
    [searchParams],
  );
  const stationCode = useMemo(
    () => normalizePhone(searchParams.get("stationCode") || ""),
    [searchParams],
  );

  const [status, setStatus] = useState<PaymentStatus>("processing");
  const [processingStep, setProcessingStep] =
    useState<ProcessingStep>("verify");
  const [statusMessage, setStatusMessage] = useState(
    "Hubinaya macluumaadka...",
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [waafiMessage, setWaafiMessage] = useState("");
  const [batteryInfo, setBatteryInfo] = useState<{
    batteryId: string;
    slotId: string;
  } | null>(null);
  const PAYMENT_REQUEST_TIMEOUT_MS = 280_000;

  const clearPaymentAbort = () => {
    if (paymentRequestAbortRef.current) {
      paymentRequestAbortRef.current.abort();
      paymentRequestAbortRef.current = null;
    }
  };

  useEffect(() => {
    if (!phoneNumber || phoneNumber.length < 7) {
      setStatus("failed");
      setErrorMessage(
        "Number-ka waa khaldan yahay. Fadlan ku noqo bogga hore oo mar kale isku day.",
      );
      return;
    }

    let cancelled = false;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const id = window.setTimeout(() => resolve(), ms);
        const check = () => {
          if (cancelled) {
            window.clearTimeout(id);
            resolve();
          }
        };
        check();
      });

    const runPayment = async () => {
      setStatus("processing");
      setProcessingStep("verify");
      setStatusMessage("Hubinaya macluumaadka...");
      setErrorMessage("");
      setWaafiMessage("");
      setBatteryInfo(null);
      let requestTimedOut = false;

      try {
        // Step 1: Verify — minimal wait for UI state transition
        await wait(500);
        if (cancelled) return;

        // Step 2: Hold — request stays in-flight while backend runs
        setProcessingStep("hold");
        setStatusMessage("Abuuraya hold-ka lacagta...");

        clearPaymentAbort();
        const controller = new AbortController();
        const requestTimeout = window.setTimeout(() => {
          requestTimedOut = true;
          controller.abort();
        }, PAYMENT_REQUEST_TIMEOUT_MS);
        paymentRequestAbortRef.current = controller;

        const paymentRes = await fetch("/api/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            phoneNumber,
            amount,
            method,
            stationCode,
          }),
        }).finally(() => {
          window.clearTimeout(requestTimeout);
        });

        const paymentData = await safeReadJson(paymentRes);

        if (cancelled) return;

        if (paymentRes.ok && paymentData.success) {
          // Show unlock/commit completion states after the backend finishes.
          setProcessingStep("unlock");
          setStatusMessage("Furaya battery-ga...");

          await wait(400);
          if (cancelled) return;

          setProcessingStep("commit");
          setStatusMessage("Xaqiijinaya lacagta ugu dambeysa...");

          await wait(200);
          if (cancelled) return;

          setStatus("success");
          setWaafiMessage(
            paymentData.waafiMessage ||
              "Battery-gu wuu soo baxay, lacagtiina waa la xaqiijiyay!",
          );
          setBatteryInfo(
            paymentData.battery_id && paymentData.slot_id
              ? {
                  batteryId: paymentData.battery_id,
                  slotId: paymentData.slot_id,
                }
              : null,
          );
          return;
        }

        setStatus("failed");
        setErrorMessage(
          mapBackendErrorMessage(
            paymentData.error || "Khalad dhacay, fadlan mar kale isku day",
            paymentData.waafiMsg,
          ),
        );
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof DOMException && error.name === "AbortError") {
          setStatus("failed");
          setErrorMessage(
            requestTimedOut
              ? "Waqtigii codsiga wuu dhamaaday. Fadlan mar kale isku day."
              : "Codsiga waa la joojiyay. Fadlan mar kale isku day.",
          );
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : "Network error, fadlan mar kale isku day.";
        setStatus("failed");
        setErrorMessage(message);
      } finally {
        paymentRequestAbortRef.current = null;
      }
    };

    runPayment();

    return () => {
      cancelled = true;
      clearPaymentAbort();
    };
  }, [amount, method, phoneNumber, stationCode]);

  const activeStepIndex = PROCESSING_STEPS.findIndex(
    (step) => step.key === processingStep,
  );

  return (
    <div
      className={cn(
        "relative min-h-screen overflow-hidden px-4 py-8 transition-colors sm:py-12",
        "bg-[radial-gradient(circle_at_top,#ede9fe,#f0ebff_35%,#f8f8ff)]",
      )}
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-100px] top-[-80px] h-72 w-72 rounded-full bg-violet-400/20 blur-3xl" />
        <div className="absolute bottom-[-110px] right-[-70px] h-72 w-72 rounded-full bg-emerald-400/20 blur-3xl" />
      </div>

      <main className="relative mx-auto w-full max-w-lg rounded-[28px] border border-white/60 bg-white/90 p-5 text-slate-800 shadow-[0_25px_70px_rgba(94,46,140,.25)] backdrop-blur-md">
        {status === "processing" && (
          <section className="rounded-2xl bg-white/70 p-4 text-center">
            <div className="mb-3 flex justify-end">
              <Link
                href="/"
                className="rounded-lg border border-slate-300 px-3 py-1 text-sm font-medium text-slate-600"
              >
                Cancel
              </Link>
            </div>

            <h1 className="text-4xl font-bold tracking-tight text-slate-900">
              Lacag Bixinta
            </h1>
            <p className="mt-2 text-xl text-slate-500">
              {method} • {formatAmount(amount)}
            </p>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              Web-kan hadda wuxuu adeegsanayaa Waafi preauthorization flow:
              marka hore lacagta waa la hold gareeyaa, kadib battery-ga ayaa la
              furaa, ugu dambeyntiina payment-ka ayaa la commit gareeyaa.
            </p>

            <div className="mt-8 flex items-start justify-between gap-2">
              {PROCESSING_STEPS.map((step, index) => {
                const isActive = index === activeStepIndex;
                const isDone = index < activeStepIndex;

                return (
                  <div
                    key={step.key}
                    className="flex min-w-0 flex-1 flex-col items-center"
                  >
                    <div className="flex w-full items-center justify-center">
                      {index > 0 && (
                        <span className="mr-2 h-[3px] w-full rounded-full bg-slate-200" />
                      )}

                      <span
                        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border text-lg font-semibold transition ${
                          isActive
                            ? "border-blue-300 bg-blue-300/80 text-white"
                            : isDone
                              ? "border-emerald-200 bg-emerald-100 text-emerald-700"
                              : "border-slate-200 bg-slate-200 text-slate-400"
                        }`}
                      >
                        {isActive ? (
                          <span className="inline-flex h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        ) : isDone ? (
                          <CheckIcon className="h-5 w-5" />
                        ) : (
                          index + 1
                        )}
                      </span>

                      {index < PROCESSING_STEPS.length - 1 && (
                        <span className="ml-2 h-[3px] w-full rounded-full bg-slate-200" />
                      )}
                    </div>

                    <p className="mt-3 text-lg font-medium text-slate-600">
                      {step.label}
                    </p>
                  </div>
                );
              })}
            </div>

            <div className="mt-8 rounded-xl border border-blue-200 bg-blue-50/80 px-4 py-5 text-2xl font-semibold text-blue-700">
              {statusMessage}
            </div>

            <div className="mt-8 flex items-center justify-center gap-3 text-3xl font-medium text-slate-600">
              <span className="inline-flex h-6 w-6 animate-spin rounded-full border-[3px] border-violet-500 border-t-transparent" />
              Fadlan sug...
            </div>

            <div className="mt-8 h-px w-full bg-slate-200" />
            <p className="mt-6 text-2xl text-slate-500">
              Number: {formatPhone(phoneNumber)}
            </p>
          </section>
        )}

        {status === "success" && (
          <section className="rounded-2xl bg-white/70 p-6 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
              <CheckIcon className="h-8 w-8 text-green-600" />
            </div>
            <h2 className="text-2xl font-bold text-green-700">Guul!</h2>
            <p className="mt-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
              {waafiMessage}
            </p>
            {batteryInfo && (
              <p className="mt-3 text-sm text-slate-600">
                Battery <strong>{batteryInfo.batteryId}</strong> waa la furay
                Slot <strong>{batteryInfo.slotId}</strong>.
              </p>
            )}
            <p className="mt-3 text-sm leading-6 text-slate-500">
              Output-ka cusub waa sidan: hold first, eject second, commit last.
              Haddii eject-ku fashilmo, hold-ka waa la cancel gareeyaa halkii user-ka
              si toos ah looga jari lahaa lacagta.
            </p>

            <div className="mt-6">
              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-violet-500 to-emerald-400 px-6 py-3 text-base font-bold text-white shadow-lg"
              >
                Samee lacag-bixin kale
              </Link>
            </div>
          </section>
        )}

        {status === "failed" && (
          <section className="rounded-2xl bg-white/70 p-6 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
              <CloseIcon className="h-8 w-8 text-red-600" />
            </div>
            <h2 className="text-2xl font-bold text-red-700">
              Lacag bixinta ma dhicin
            </h2>
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {errorMessage}
            </p>

            <div className="mt-6">
              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-violet-500 to-emerald-400 px-6 py-3 text-base font-bold text-white shadow-lg"
              >
                Dib u isku day
              </Link>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
