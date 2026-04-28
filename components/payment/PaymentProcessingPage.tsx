"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { normalizePhone } from "@/components/payment/helpers";

type UIState =
  | "idle"
  | "prechecking"
  | "awaiting_payment"
  | "processing_payment"
  | "paid"
  | "ejecting"
  | "verifying"
  | "success"
  | "manual_required"
  | "failed";

type StatusResponse = {
  status?:
    | "pending_payment"
    | "held"
    | "paid"
    | "processing"
    | "verifying"
    | "verified"
    | "confirm_required"
    | "capture_in_progress"
    | "captured"
    | "failed";
  reason_code?:
    | "STATION_OFFLINE"
    | "INSUFFICIENT_FUNDS"
    | "USER_CANCELLED"
    | "LOW_BATTERY"
    | "NO_BATTERIES"
    | "PROVIDER_ERROR"
    | "VERIFICATION_FAILED"
    | "UNLOCK_FAILED";
  message?: string;
  transactionId?: string;
  battery_id?: string;
  slot_id?: string;
  error?: string;
};

function mapBackendStatusToUi(status?: StatusResponse["status"]): UIState {
  switch (status) {
    case "pending_payment":
      return "awaiting_payment";
    case "paid":
      return "paid";
    case "held":
    case "processing":
      return "ejecting";
    case "verifying":
    case "verified":
    case "capture_in_progress":
      return "verifying";
    case "confirm_required":
      return "manual_required";
    case "captured":
      return "success";
    case "failed":
      return "failed";
    default:
      return "processing_payment";
  }
}

function friendlyError(reason?: StatusResponse["reason_code"], fallback?: string) {
  switch (reason) {
    case "STATION_OFFLINE":
      return "Station-kan ma shaqeynayo";
    case "NO_BATTERIES":
      return "Ma jiro battery diyaar ah";
    case "LOW_BATTERY":
      return "Battery-yadu wali way dallacayaan";
    case "USER_CANCELLED":
      return "Waad joojisay bixinta. Lacag lagama jarin.";
    case "INSUFFICIENT_FUNDS":
      return "Haraaga kuma filna.";
    default:
      return fallback || "Wax khalad ah ayaa dhacay. Fadlan mar kale isku day.";
  }
}

export function PaymentProcessingPage() {
  const searchParams = useSearchParams();
  const requestAbortRef = useRef<AbortController | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const amount = useMemo(() => {
    const raw = Number(searchParams.get("amount"));
    return Number.isFinite(raw) && raw > 0 ? raw : 0.75;
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

  const [uiState, setUiState] = useState<UIState>("idle");
  const [transactionId, setTransactionId] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [batteryInfo, setBatteryInfo] = useState<{ batteryId?: string; slotId?: string }>({});

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  useEffect(() => {
    if (!phoneNumber || !idempotencyKey) {
      setUiState("failed");
      setErrorMessage("Macluumaad sax ah lama helin.");
      return;
    }

    let cancelled = false;

    const run = async () => {
      setUiState("prechecking");

      const pollStatus = async (txId: string) => {
        try {
          const res = await fetch(`/api/payment/status?transactionId=${txId}`, {
            cache: "no-store",
          });
          const data: StatusResponse = await res.json();
          if (!res.ok) return;

          const mapped = mapBackendStatusToUi(data.status);
          setUiState(mapped);

          if (data.status === "failed") {
            setErrorMessage(friendlyError(data.reason_code, data.message || data.error));
            stopPolling();
          }
          if (data.status === "captured") {
            setBatteryInfo({ batteryId: data.battery_id, slotId: data.slot_id });
            stopPolling();
          }
        } catch {
          // keep polling
        }
      };

      try {
        requestAbortRef.current = new AbortController();
        const response = await fetch("/api/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: requestAbortRef.current.signal,
          body: JSON.stringify({
            phoneNumber,
            amount,
            stationCode,
            idempotencyKey,
          }),
        });
        const data: StatusResponse & { success?: boolean } = await response.json();
        if (cancelled) return;

        const txId = data.transactionId || idempotencyKey;
        setTransactionId(txId);

        if (!response.ok || data.status === "failed") {
          setUiState("failed");
          setErrorMessage(friendlyError(data.reason_code, data.error || data.message));
          return;
        }

        if (data.success) {
          setUiState("success");
          setBatteryInfo({ batteryId: data.battery_id, slotId: data.slot_id });
          return;
        }

        setUiState(mapBackendStatusToUi(data.status));
        await pollStatus(txId);
        pollIntervalRef.current = setInterval(() => void pollStatus(txId), 2000);
      } catch {
        if (!cancelled) {
          setUiState("failed");
          setErrorMessage("Cilad ayaa dhacday intii lacag bixintu socotay.");
        }
      }
    };

    run();

    return () => {
      cancelled = true;
      requestAbortRef.current?.abort();
      stopPolling();
    };
  }, [amount, idempotencyKey, phoneNumber, stationCode]);

  const content = (() => {
    if (uiState === "prechecking") {
      return {
        title: "🔍 Checking station...",
        subtitle: "Fadlan sug, waxaan hubinaynaa station-ka...",
      };
    }
    if (uiState === "awaiting_payment") {
      return {
        title: "📱 Enter your PIN to continue",
        subtitle: "Gali PIN-ka si aad u bixiso",
      };
    }
    if (uiState === "processing_payment") {
      return {
        title: "⏳ Waiting for payment confirmation...",
        subtitle: "Waxaan sugaynaa xaqiijinta lacagta...",
      };
    }
    if (uiState === "paid") {
      return {
        title: "💰 Payment received. Preparing your battery...",
        subtitle: "Lacagta waa la helay. Power bank-ga waa laguu diyaarinayaa...",
      };
    }
    if (uiState === "ejecting") {
      return {
        title: "🔓 Releasing battery...",
        subtitle: "Qalabka waa la furayaa...",
      };
    }
    if (uiState === "verifying") {
      return {
        title: "🔍 Confirming delivery...",
        subtitle: "Xaqiijin ayaa socota...",
      };
    }
    if (uiState === "manual_required") {
      return {
        title: "Manual confirmation required",
        subtitle: "Fadlan xaqiiji haddii power bank-gu soo baxay.",
      };
    }
    if (uiState === "success") {
      return {
        title: "✅ Take your power bank",
        subtitle: "Fadlan qaado power bank-ga",
      };
    }
    return {
      title: "Payment failed",
      subtitle: errorMessage || "Wax khalad ah ayaa dhacay.",
    };
  })();

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4 bg-[#f8fafc]">
      <div className="relative w-full max-w-md">
        <main className="overflow-hidden rounded-[32px] border border-white bg-white/90 p-6 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.14)]">
          <div className="space-y-6 py-4 text-center">
            <p className="text-xs uppercase tracking-widest text-slate-400">
              {transactionId ? `TX: ${transactionId}` : "Danab Payment"}
            </p>
            <h1 className="text-xl font-bold text-slate-900">{content.title}</h1>
            <p className="text-sm text-slate-600">{content.subtitle}</p>

            {uiState === "success" && (batteryInfo.batteryId || batteryInfo.slotId) ? (
              <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-4">
                <p className="text-sm font-semibold text-emerald-700">
                  Slot: {batteryInfo.slotId || "-"} • ID: {batteryInfo.batteryId || "-"}
                </p>
              </div>
            ) : null}

            {uiState === "failed" ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
                <p className="text-sm font-medium text-rose-700">{errorMessage}</p>
              </div>
            ) : null}

            {(uiState === "success" || uiState === "failed" || uiState === "manual_required") ? (
              <Link
                href="/"
                className="inline-flex w-full items-center justify-center rounded-2xl bg-slate-900 px-6 py-4 text-lg font-bold text-white hover:bg-slate-800"
              >
                {uiState === "success" ? "Finish" : "Dib u isku day"}
              </Link>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

