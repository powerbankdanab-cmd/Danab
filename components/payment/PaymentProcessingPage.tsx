"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  CheckIcon,
  CloseIcon,
  ArrowRightIcon,
  HelpCircleIcon
} from "@/components/payment/Icons";
import {
  cn,
  mapBackendErrorMessage,
  normalizePhone,
} from "@/components/payment/helpers";
import {
  PaymentStatus,
} from "@/components/payment/types";

type ApiResponse = {
  success?: boolean;
  status?: "confirm_required" | "success" | "failed" | "pending";
  message?: string;
  transactionId?: string;
  error?: string;
  battery_id?: string;
  slot_id?: string;
  waafiMessage?: string;
};

export function PaymentProcessingPage() {
  const searchParams = useSearchParams();
  const paymentRequestAbortRef = useRef<AbortController | null>(null);

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
  const [batteryInfo, setBatteryInfo] = useState<{
    batteryId: string;
    slotId: string;
  } | null>(null);

  const PAYMENT_REQUEST_TIMEOUT_MS = 15000; // 15s timeout for UI protection

  useEffect(() => {
    if (!phoneNumber || !idempotencyKey) {
      setStatus("FAILED");
      setErrorMessage("Macluumaad sax ah lama helin. Fadlan mar kale isku day.");
      return;
    }

    let isCancelled = false;

    const runPayment = async () => {
      setStatus("CONNECTING");

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          if (!isCancelled) {
            controller.abort();
            setStatus("FAILED");
            setErrorMessage("Waqtiga codsiga wuu dhamaaday. Fadlan mar kale isku day.");
          }
        }, PAYMENT_REQUEST_TIMEOUT_MS);

        paymentRequestAbortRef.current = controller;

        // Transitions based on time/progress (simulated steps during the long POST)
        // Since we have one POST, we'll use timeouts to move through UI steps
        // unless we have a polling endpoint (which we'll assume is not there yet).
        const step1 = setTimeout(() => !isCancelled && setStatus("UNLOCKING"), 2000);
        const step2 = setTimeout(() => !isCancelled && setStatus("VERIFYING"), 5000);

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

        clearTimeout(timeoutId);
        clearTimeout(step1);
        clearTimeout(step2);

        if (isCancelled) return;

        const data: ApiResponse = await response.json();

        if (data.status === "confirm_required") {
          setTransactionId(data.transactionId || idempotencyKey);
          setStatus("CONFIRM_REQUIRED");
          return;
        }

        if (data.status === "pending") {
          setTransactionId(data.transactionId || idempotencyKey);
          setStatus("PENDING");
          return;
        }

        if (response.ok && (data.success || data.status === "success")) {
          setBatteryInfo(
            data.battery_id && data.slot_id
              ? { batteryId: data.battery_id, slotId: data.slot_id }
              : null
          );
          setStatus("SUCCESS");
        } else {
          setStatus("FAILED");
          setErrorMessage(mapBackendErrorMessage(data.error || "Khalad dhacay"));
        }
      } catch (error) {
        if (!isCancelled) {
          setStatus("FAILED");
          setErrorMessage(error instanceof Error ? error.message : "Cillad farsamo ayaa dhacday.");
        }
      }
    };

    runPayment();

    return () => {
      isCancelled = true;
      paymentRequestAbortRef.current?.abort();
    };
  }, [amount, idempotencyKey, phoneNumber, stationCode]);

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

  const renderContent = () => {
    switch (status) {
      case "CONNECTING":
      case "UNLOCKING":
      case "VERIFYING":
        return (
          <div className="space-y-8 py-4 text-center">
            <div className="flex justify-center">
              <div className="relative h-20 w-20">
                <div className="absolute inset-0 animate-ping rounded-full bg-violet-400/20" />
                <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-white shadow-xl">
                  <span className="h-10 w-10 animate-spin rounded-full border-4 border-violet-500 border-t-transparent" />
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <h1 className="text-2xl font-bold text-slate-900">
                Fadlan sug, waxaan diyaarinaynaa power bank-gaaga
              </h1>

              <div className="flex flex-col items-center gap-2">
                <p className={cn(
                  "text-lg font-semibold transition-colors duration-500",
                  status === "CONNECTING" ? "text-violet-600" : "text-slate-400"
                )}>
                  1. Ku xiridda qalabka...
                </p>
                <p className={cn(
                  "text-lg font-semibold transition-colors duration-500",
                  status === "UNLOCKING" ? "text-violet-600" : "text-slate-400"
                )}>
                  2. Sii deynta power bank-ga...
                </p>
                <p className={cn(
                  "text-lg font-semibold transition-colors duration-500",
                  status === "VERIFYING" ? "text-violet-600" : "text-slate-400"
                )}>
                  3. Hubinta inuu si sax ah u soo baxay...
                </p>
              </div>

              {status === "VERIFYING" && (
                <div className="mt-4 animate-pulse rounded-xl bg-violet-50 p-4 border border-violet-100">
                  <p className="text-sm font-medium text-violet-700">
                    Waxaan sugaynaa dhowr ilbiriqsi si aan u xaqiijino inuu si dhab ah u soo baxay.
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-2xl bg-slate-50 p-4 border border-slate-100">
              <p className="text-sm text-slate-500">
                Money Status: <span className="font-bold text-slate-700">HELD (Safe)</span>
              </p>
              <p className="mt-1 text-[10px] text-slate-400">
                Lacagta waxaa lagaa jarayaa kaliya marka aan hubino inuu power bank-gu gacantaada soo galay.
              </p>
            </div>
          </div>
        );

      case "SUCCESS":
        return (
          <div className="space-y-6 py-4 text-center">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 shadow-inner">
              <CheckIcon className="h-10 w-10 text-emerald-600" />
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-black text-slate-900 uppercase tracking-tight">
                Power Bank Waa Diyaar
              </h1>
              <p className="text-lg text-slate-600">
                Power bank-gaaga si guul leh ayuu u soo baxay.
              </p>
            </div>
            <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-5 shadow-sm">
              <p className="text-xl font-bold text-emerald-800">
                Fadlan ka qaado qalabka
              </p>
              {batteryInfo && (
                <p className="mt-2 text-sm text-emerald-600 font-medium">
                  Slot: {batteryInfo.slotId} • ID: {batteryInfo.batteryId}
                </p>
              )}
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

      case "CONFIRM_REQUIRED":
        return (
          <div className="space-y-8 py-4 text-center">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-amber-100">
              <HelpCircleIcon className="h-10 w-10 text-amber-600" />
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-black text-slate-900 uppercase">
                Power bank ma soo baxay?
              </h1>
              <p className="text-lg text-slate-600">
                Waxaan rabnaa inaad lacag bixiso kaliya marka aad hesho.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <button
                onClick={() => handleConfirm(true)}
                className="flex w-full items-center justify-center rounded-2xl bg-emerald-500 px-6 py-5 text-xl font-black text-white shadow-lg hover:bg-emerald-600 active:scale-95"
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

      case "PENDING":
        return (
          <div className="space-y-8 py-4 text-center">
            <div className="flex justify-center">
              <div className="relative h-20 w-20">
                <div className="absolute inset-0 animate-ping rounded-full bg-blue-400/20" />
                <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-white shadow-xl">
                  <span className="h-10 w-10 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
                </div>
              </div>
            </div>
            <div className="space-y-3">
              <h1 className="text-2xl font-bold text-slate-900">
                Fadlan dhammee PIN-ka taleefankaaga
              </h1>
              <p className="text-lg text-slate-600">
                Waxaan sugaynaa xaqiijin.
              </p>
            </div>
            <div className="rounded-2xl bg-blue-50 p-4 border border-blue-100">
              <p className="text-sm font-medium text-blue-700">
                Please complete the payment on your phone. We are waiting for confirmation.
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4 border border-slate-100">
              <p className="text-sm text-slate-500">
                Money Status: <span className="font-bold text-slate-700">PENDING</span>
              </p>
              <p className="mt-1 text-[10px] text-slate-400">
                Lacagta lama jarin weli. Waxaan sugaynaa xaqiijintaada.
              </p>
            </div>
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
