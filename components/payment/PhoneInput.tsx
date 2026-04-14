"use client";

import { cn } from "@/components/payment/helpers";

export function PhoneInput({
  value,
  onChange,
  placeholder,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  error?: string;
}) {
  return (
    <div className="mx-3 mt-5 sm:mx-4">
      <label className="mb-2 block text-sm font-semibold text-gray-700">
        Telefoon Numberka
      </label>
      <div
        className={cn(
          "flex overflow-hidden rounded-xl border shadow-sm transition-all focus-within:ring-2 focus-within:ring-violet-200",
          error ? "border-red-500 bg-red-50" : "border-gray-200 bg-white",
        )}
      >
        <span className="flex items-center gap-2 bg-gray-100 px-4 py-3 text-sm font-semibold text-gray-700">
          <span aria-hidden="true">🇸🇴</span>
          +252
        </span>
        <input
          type="tel"
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full bg-transparent px-3 py-3 text-sm font-medium text-gray-700 outline-none placeholder:text-gray-400"
          placeholder={placeholder}
        />
      </div>
      {error && (
        <p className="mt-2 text-xs font-medium text-red-600">{error}</p>
      )}
      <p className="mt-2 text-xs text-gray-500">
        Fadlan Gali Numberka lacagta la Dirayo
      </p>
    </div>
  );
}
