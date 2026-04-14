"use client";

import Link from "next/link";

import { cn } from "@/components/payment/helpers";

export function RulesAgreement({
  checked,
  error,
  onToggle,
}: {
  checked: boolean;
  error?: string;
  onToggle: () => void;
}) {
  return (
    <div className="mx-3 mt-5 sm:mx-4">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border-2 p-4 text-left shadow-sm transition",
          checked
            ? "border-violet-400 bg-violet-50/60"
            : "border-gray-200 bg-white hover:border-violet-200",
          error && "border-red-400",
        )}
      >
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2",
            checked
              ? "border-violet-500 bg-violet-500 text-white"
              : "border-gray-300 bg-white text-transparent",
          )}
        >
          ✓
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-semibold text-gray-700">
            Waan ogolahay
          </span>
          <Link
            href="/rules"
            target="_blank"
            onClick={(event) => event.stopPropagation()}
            className="text-xs font-medium text-violet-500 underline decoration-dotted underline-offset-2 hover:text-violet-600"
          >
            Shuruudaha iyo xeerarka isticmaalka Danab
          </Link>
        </span>
      </button>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
