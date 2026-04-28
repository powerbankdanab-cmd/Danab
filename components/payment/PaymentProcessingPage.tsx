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
  stage?: "precheck" | "payment" | "delivery" | "unlock" | "verification" | "capture" | "system";
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
  | "PROVIDER_DECLINED"
  | "LOW_BATTERY"
  | "NO_BATTERIES"
  | "PAYMENT_TIMEOUT"
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

const ERROR_MAP: Record<string, Record<string, string>> = {
  precheck: {
    STATION_OFFLINE: "Station-kan ma shaqeynayo waa Offline",
    NO_BATTERIES: "Ma jiro battery diyaar ah station-kan",
    LOW_BATTERY: "Battery-yadu wali wuu charging.. , diyaar ma ahan",
  },
  payment: {
    USER_CANCELLED: "Waad joojisay bixinta",
    PROVIDER_DECLINED: "Waad joojisay bixinta",
    INSUFFICIENT_FUNDS: "Haraaga kuma filna",
    PAYMENT_TIMEOUT: "Waqtiga bixintu wuu dhammaaday",
    PROVIDER_ERROR: "Cilad ayaa ka jirta bixinta",
  },
};

function stageAwareMessage(
  stage?: StatusResponse["stage"],
  reason?: StatusResponse["reason_code"],
  fallback?: string,
) {
  if (stage === "delivery" || stage === "unlock" || stage === "verification" || stage === "capture") {
    return "Lacagta waa la helay, fadlan sug...";
  }

  const fromMap = stage && reason ? ERROR_MAP[stage]?.[reason] : undefined;
  if (fromMap) return fromMap;
  if (fallback) return fallback;
  return "Cilad ayaa dhacday, fadlan isku day mar kale";
}

export function PaymentProcessingPage() {
  const searchParams = useSearchParams();
  const requestAbortRef = useRef<AbortController | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollStartRef = useRef<number | null>(null);

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
  const [infoMessage, setInfoMessage] = useState("");
  const [batteryInfo, setBatteryInfo] = useState<{ batteryId?: string; slotId?: string }>({});
  const [confirmBusy, setConfirmBusy] = useState(false);

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const applyStatus = (data: StatusResponse) => {
    const mapped = mapBackendStatusToUi(data.status);
    setUiState(mapped);

    if (data.status === "failed") {
      const deliveryLikeFailure =
        data.stage === "unlock" ||
        data.stage === "delivery" ||
        data.stage === "verification" ||
        data.stage === "capture";

      if (deliveryLikeFailure) {
        setUiState("paid");
        setInfoMessage("Lacagta waa la helay, fadlan sug...");
        stopPolling();
        return;
      }

      setErrorMessage(stageAwareMessage(data.stage, data.reason_code, data.message || data.error));
      stopPolling();
      return;
    }

    if (data.status === "captured") {
      setBatteryInfo({ batteryId: data.battery_id, slotId: data.slot_id });
      stopPolling();
      return;
    }
  };

  const confirmManualResult = async (confirmed: boolean) => {
    if (!transactionId || confirmBusy) return;
    setConfirmBusy(true);
    try {
      const res = await fetch("/api/pay/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId, confirmed }),
      });
      const data: StatusResponse & { success?: boolean } = await res.json();
      if (!res.ok || data.status === "failed") {
        setUiState("failed");
        setErrorMessage(stageAwareMessage(data.stage, data.reason_code, data.error || data.message));
        return;
      }
      if (data.success || data.status === "captured") {
        setUiState("success");
        setBatteryInfo({ batteryId: data.battery_id, slotId: data.slot_id });
        return;
      }
      applyStatus(data);
    } catch {
      setUiState("failed");
      setErrorMessage("Xaqiijinta gacanta way fashilantay. Fadlan mar kale isku day.");
    } finally {
      setConfirmBusy(false);
    }
  };

  useEffect(() => {
    if (!phoneNumber || !idempotencyKey) {
      setUiState("failed");
      setErrorMessage("Macluumaad sax ah lama helin.");
      return;
    }

    let cancelled = false;

    const pollStatus = async (txId: string) => {
      try {
        const res = await fetch(`/api/payment/status?transactionId=${txId}`, {
          cache: "no-store",
        });
        const data: StatusResponse = await res.json();
        if (!res.ok || cancelled) return;

        applyStatus(data);

        const pollStartedAt = pollStartRef.current;
        if (pollStartedAt && Date.now() - pollStartedAt > 60_000) {
          stopPolling();
          setInfoMessage("Waxaan wali hubinaynaa lacagta. Fadlan sug.");
        }
      } catch {
        // keep polling
      }
    };

    const run = async () => {
      setUiState("prechecking");
      setInfoMessage("");
      setErrorMessage("");

      try {
        requestAbortRef.current = new AbortController();
        const precheckResponse = await fetch("/api/pay/precheck", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: requestAbortRef.current.signal,
          body: JSON.stringify({ stationCode }),
        });

        if (!precheckResponse.ok) {
          const precheckData: StatusResponse = await precheckResponse.json();
          setUiState("failed");
          setErrorMessage(
            stageAwareMessage(
              precheckData.stage,
              precheckData.reason_code,
              precheckData.error || precheckData.message,
            ),
          );
          return;
        }

        setUiState("awaiting_payment");

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
          setErrorMessage(stageAwareMessage(data.stage, data.reason_code, data.error || data.message));
          return;
        }

        if (data.success || data.status === "captured") {
          setUiState("success");
          setBatteryInfo({ batteryId: data.battery_id, slotId: data.slot_id });
          return;
        }

        applyStatus(data);

        await pollStatus(txId);
        pollStartRef.current = Date.now();
        pollIntervalRef.current = setInterval(() => void pollStatus(txId), 2000);
      } catch {
        if (!cancelled) {
          setUiState("failed");
          setErrorMessage("Cilad ayaa dhacday intii lacag bixintu socotay.");
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      requestAbortRef.current?.abort();
      stopPolling();
    };
  }, [amount, idempotencyKey, phoneNumber, stationCode]);

  const content = (() => {
    if (uiState === "prechecking") {
      return {
        title: "Checking station...",
        subtitle: "Fadlan sug, waxaan hubinaynaa station-ka...",
      };
    }
    if (uiState === "awaiting_payment") {
      return {
        title: "Enter your PIN to continue",
        subtitle: "Gali PIN-ka si aad u bixiso",
      };
    }
    if (uiState === "processing_payment") {
      return {
        title: "Waiting for payment confirmation...",
        subtitle: "Waxaan sugaynaa xaqiijinta lacagta...",
      };
    }
    if (uiState === "paid") {
      return {
        title: "Payment received. Preparing your battery...",
        subtitle: "Lacagta waa la helay. Power bank-ga waa laguu diyaarinayaa...",
      };
    }
    if (uiState === "ejecting") {
      return {
        title: "Releasing battery...",
        subtitle: "Qalabka waa la furayaa...",
      };
    }
    if (uiState === "verifying") {
      return {
        title: "Confirming delivery...",
        subtitle: "Xaqiijin ayaa socota...",
      };
    }
    if (uiState === "manual_required") {
      return {
        title: "Did the power bank come out?",
        subtitle: "Fadlan xaqiiji haddii power bank-gu soo baxay.",
      };
    }
    if (uiState === "success") {
      return {
        title: "Take your power bank",
        subtitle: "Fadlan qaado power bank-ga",
      };
    }
    return {
      title: "Payment failed",
      subtitle: errorMessage || "Wax khalad ah ayaa dhacay.",
    };
  })();

  const tone =
    uiState === "success"
      ? "success"
      : uiState === "failed"
        ? "danger"
        : uiState === "manual_required"
          ? "warning"
          : "active";

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,_#dcf2ff_0%,_#eef4ff_44%,_#f8fafc_100%)] p-4">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-cyan-200/50 blur-3xl" />
        <div className="absolute right-0 top-1/3 h-80 w-80 rounded-full bg-indigo-200/40 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-violet-100/50 blur-3xl" />
      </div>
      <div className="relative w-full max-w-md">
        <main className="relative overflow-hidden rounded-[32px] border border-white/80 bg-white/90 p-6 shadow-[0_32px_70px_-16px_rgba(15,23,42,0.28)] backdrop-blur-xl">
          <div className="pointer-events-none absolute inset-0 rounded-[32px] bg-[linear-gradient(150deg,rgba(14,165,233,0.08),rgba(255,255,255,0.62)_44%,rgba(99,102,241,0.10))]" />
          <div className="relative space-y-6 py-4 text-center">
            <div className="mx-auto h-2 w-16 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-emerald-400" />
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              {transactionId ? `TX: ${transactionId}` : "Danab Payment"}
            </p>
            <div
              className={`mx-auto inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                tone === "success"
                  ? "bg-emerald-100 text-emerald-700"
                  : tone === "danger"
                    ? "bg-rose-100 text-rose-700"
                    : tone === "warning"
                      ? "bg-amber-100 text-amber-700"
                      : "bg-sky-100 text-sky-700"
              }`}
            >
              {uiState.replaceAll("_", " ").toUpperCase()}
            </div>
            <h1 className="text-2xl font-extrabold leading-tight text-slate-900">{content.title}</h1>
            <p className="mx-auto max-w-[28ch] text-sm leading-relaxed text-slate-600">{content.subtitle}</p>

            {infoMessage ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50/90 p-4">
                <p className="text-sm font-medium text-amber-800">{infoMessage}</p>
              </div>
            ) : null}

            {uiState === "success" && (batteryInfo.batteryId || batteryInfo.slotId) ? (
              <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50/90 p-4">
                <p className="text-sm font-semibold text-emerald-700">
                  Slot: {batteryInfo.slotId || "-"} - ID: {batteryInfo.batteryId || "-"}
                </p>
              </div>
            ) : null}

            {uiState === "failed" ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50/90 p-4">
                <p className="text-sm font-medium text-rose-700">{errorMessage}</p>
              </div>
            ) : null}

            {uiState === "manual_required" ? (
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => void confirmManualResult(true)}
                  disabled={confirmBusy}
                  className="rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-500/30 disabled:opacity-60"
                >
                  Yes / Haa
                </button>
                <button
                  type="button"
                  onClick={() => void confirmManualResult(false)}
                  disabled={confirmBusy}
                  className="rounded-2xl bg-rose-600 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-rose-500/30 disabled:opacity-60"
                >
                  No / Maya
                </button>
              </div>
            ) : null}

            {(uiState === "success" || uiState === "failed") ? (
              <Link
                href="/"
                className="inline-flex w-full items-center justify-center rounded-2xl bg-gradient-to-r from-slate-900 via-indigo-900 to-slate-900 px-6 py-4 text-lg font-bold text-white shadow-xl shadow-slate-900/30 hover:brightness-110"
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
