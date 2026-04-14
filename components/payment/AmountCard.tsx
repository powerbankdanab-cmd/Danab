"use client";

import { formatAmount } from "@/components/payment/helpers";

export function AmountCard({ amount }: { amount: number }) {
  return (
    <div className="mx-3 mt-4 rounded-2xl bg-violet-50/70 px-4 py-5 text-center shadow-sm sm:mx-4 sm:mt-5 sm:px-6 sm:py-6">
      <p className="text-sm font-semibold text-violet-500">Amount to Pay:</p>
      <p className="mt-2 text-4xl font-black text-violet-600 sm:text-5xl">
        {formatAmount(amount)}
      </p>
    </div>
  );
}
