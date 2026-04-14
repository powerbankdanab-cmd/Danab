"use client";

import { MoonIcon, SunIcon } from "@/components/payment/Icons";
import { cn } from "@/components/payment/helpers";

export function PaymentHeader({
  darkMode,
  onToggleTheme,
}: {
  darkMode: boolean;
  onToggleTheme: () => void;
}) {
  return (
    <header className="mb-5 flex items-center justify-between px-1">
      <div className="mx-auto flex flex-1 justify-center">
        <img
          src="/danab-logo.svg"
          alt="Danab Powerbank Station"
          className={cn(
            "h-14 w-auto sm:h-16",
            darkMode && "brightness-0 invert",
          )}
        />
      </div>

      <button
        onClick={onToggleTheme}
        aria-label="Toggle dark mode"
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full border shadow-sm transition",
          darkMode
            ? "border-white/15 bg-slate-800 text-amber-300 hover:bg-slate-700"
            : "border-slate-200 bg-white text-purple-700 hover:bg-slate-50",
        )}
      >
        {darkMode ? (
          <SunIcon className="h-5 w-5" />
        ) : (
          <MoonIcon className="h-5 w-5" />
        )}
      </button>
    </header>
  );
}
