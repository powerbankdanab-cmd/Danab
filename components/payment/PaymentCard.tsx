"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { AmountCard } from "@/components/payment/AmountCard";
import {
  PAYMENT_METHODS,
  PHONE_PLACEHOLDER_BY_METHOD,
  TIME_OPTIONS,
} from "@/components/payment/constants";
import {
  cn,
  normalizePhone,
  validatePaymentInput,
} from "@/components/payment/helpers";
import { MethodPicker } from "@/components/payment/MethodPicker";
import { PayButton } from "@/components/payment/PayButton";
import { PaymentHeader } from "@/components/payment/PaymentHeader";
import { PhoneInput } from "@/components/payment/PhoneInput";
import { RulesAgreement } from "@/components/payment/RulesAgreement";
import { TimeOptions } from "@/components/payment/TimeOptions";
import { PaymentMethod } from "@/components/payment/types";
import { getStationCode } from "@/lib/client/station";

const PAYMENT_FLOW_RESET_KEY = "caste:payment-flow-reset-home-form";
const DEFAULT_AMOUNT = 0.75;
const DEFAULT_METHOD: PaymentMethod = "EVC Plus";

function createIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `pay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function PaymentCard({
  darkMode,
  onToggleTheme,
}: {
  darkMode: boolean;
  onToggleTheme: () => void;
}) {
  const router = useRouter();

  const [selectedAmount, setSelectedAmount] = useState(DEFAULT_AMOUNT);
  const [selectedMethod, setSelectedMethod] =
    useState<PaymentMethod>(DEFAULT_METHOD);
  const [phone, setPhone] = useState("");
  const [agreeRules, setAgreeRules] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ phone?: string; agreeRules?: string }>(
    {},
  );

  useEffect(() => {
    router.prefetch("/payment");

    const resetForm = () => {
      setSelectedAmount(DEFAULT_AMOUNT);
      setSelectedMethod(DEFAULT_METHOD);
      setPhone("");
      setAgreeRules(true);
      setErrors({});
      setIsSubmitting(false);
    };

    const maybeResetOnReturnFromPayment = () => {
      if (window.sessionStorage.getItem(PAYMENT_FLOW_RESET_KEY) === "1") {
        window.sessionStorage.removeItem(PAYMENT_FLOW_RESET_KEY);
        resetForm();
        return;
      }

      setIsSubmitting(false);
    };

    const onVisibilityChange = () => {
      if (!document.hidden) {
        maybeResetOnReturnFromPayment();
      }
    };

    maybeResetOnReturnFromPayment();
    window.addEventListener("pageshow", maybeResetOnReturnFromPayment);
    window.addEventListener("focus", maybeResetOnReturnFromPayment);
    window.addEventListener("popstate", maybeResetOnReturnFromPayment);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("pageshow", maybeResetOnReturnFromPayment);
      window.removeEventListener("focus", maybeResetOnReturnFromPayment);
      window.removeEventListener("popstate", maybeResetOnReturnFromPayment);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  const handlePay = () => {
    if (isSubmitting) {
      return;
    }

    const formErrors = validatePaymentInput(phone, agreeRules);
    setErrors(formErrors);

    if (Object.keys(formErrors).length > 0) {
      return;
    }

    const cleanPhone = normalizePhone(phone);

    setIsSubmitting(true);
    window.sessionStorage.setItem(PAYMENT_FLOW_RESET_KEY, "1");
    const stationCode = getStationCode();
    const idempotencyKey = createIdempotencyKey();
    const params = new URLSearchParams({
      phone: cleanPhone,
      amount: String(selectedAmount),
      method: selectedMethod,
      idempotencyKey,
      ...(stationCode ? { stationCode } : {}),
    });

    router.push(`/payment?${params.toString()}`);
  };

  return (
    <main
      className={cn(
        "relative mx-auto w-full max-w-md rounded-3xl border p-4 shadow-lg sm:p-5",
        darkMode
          ? "border-white/[0.08] bg-white/[0.06] text-white shadow-2xl shadow-violet-500/10 backdrop-blur-xl"
          : "border-gray-200 bg-white text-slate-800",
      )}
    >
      <PaymentHeader darkMode={darkMode} onToggleTheme={onToggleTheme} />

      <section className="rounded-3xl pb-6">
        <TimeOptions
          options={TIME_OPTIONS}
          selectedAmount={selectedAmount}
          onSelect={setSelectedAmount}
        />

        <AmountCard amount={selectedAmount} />

        <MethodPicker
          methods={PAYMENT_METHODS}
          selectedMethod={selectedMethod}
          onSelect={setSelectedMethod}
        />

        <PhoneInput
          value={phone}
          onChange={setPhone}
          placeholder={PHONE_PLACEHOLDER_BY_METHOD[selectedMethod]}
          error={errors.phone}
        />

        <RulesAgreement
          checked={agreeRules}
          onToggle={() => setAgreeRules((prev) => !prev)}
          error={errors.agreeRules}
        />

        <PayButton loading={isSubmitting} onClick={handlePay} />
      </section>

      <footer
        className={cn(
          "mt-6 px-4 py-3 text-center text-xs sm:text-sm",
          darkMode ? "text-gray-400" : "text-gray-600",
        )}
      >
        Call us any feedback or problem{" "}
        <span
          className={cn("font-bold", darkMode ? "text-white" : "text-gray-900")}
        >
          616586503 / 616251068
        </span>
      </footer>
    </main>
  );
}
