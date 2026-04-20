"use client";

import { ArrowRightIcon } from "@/components/payment/Icons";

export function PayButton({
  loading,
  onClick,
}: {
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <div className="mx-3 sm:mx-4">
      <button
        onClick={onClick}
        disabled={loading}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-emerald-400 px-4 py-4 text-lg font-bold text-white shadow-md transition-all hover:scale-[1.02] hover:shadow-lg active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:scale-100 sm:py-4"
      >
        {loading ? "Fadlan sug..." : "Bixi oo Qaado Power Bank"}
        {!loading && <ArrowRightIcon className="h-5 w-5" />}
      </button>
      <p className="mt-3 text-center text-xs text-slate-500 font-medium leading-relaxed">
        Lacagta waxaa lagaa jarayaa kaliya marka aad hesho power bank-ga.
      </p>
    </div>
  );
}
