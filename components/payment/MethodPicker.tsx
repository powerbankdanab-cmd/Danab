"use client";

import { cn } from "@/components/payment/helpers";
import { PaymentMethod } from "@/components/payment/types";

export function MethodPicker({
  methods,
  selectedMethod,
  onSelect,
}: {
  methods: PaymentMethod[];
  selectedMethod: PaymentMethod;
  onSelect: (method: PaymentMethod) => void;
}) {
  return (
    <div className="mx-3 mt-6 sm:mx-4">
      <p className="mb-3 text-sm font-semibold text-gray-700">
        Habka Lacag Bixinta
      </p>
      <div className="grid grid-cols-3 gap-2.5 text-xs font-bold sm:gap-3">
        {methods.map((method) => {
          const isActive = selectedMethod === method;
          return (
            <button
              key={method}
              onClick={() => onSelect(method)}
              className={cn(
                "rounded-full px-3 py-2.5 shadow-sm transition-all hover:scale-[1.02] active:scale-[0.98] sm:px-4 sm:py-3",
                isActive
                  ? "bg-violet-500 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200",
              )}
            >
              {method}
            </button>
          );
        })}
      </div>
    </div>
  );
}
