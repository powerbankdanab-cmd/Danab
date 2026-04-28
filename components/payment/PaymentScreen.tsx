"use client";

import { useState } from "react";

import { PaymentCard } from "@/components/payment/PaymentCard";
import { cn } from "@/components/payment/helpers";

export function PaymentScreen() {
  const [darkMode, setDarkMode] = useState(false);

  return (
    <div
      className={cn(
        "relative min-h-screen overflow-hidden px-3 py-6 transition-colors sm:px-4 sm:py-12",
        darkMode
          ? "bg-[radial-gradient(circle_at_top,_#2e1e57_0%,_#171428_45%,_#11121d_100%)]"
          : "bg-[radial-gradient(circle_at_top,_#dff2ff_0%,_#f4f7ff_42%,_#f7fafc_100%)]",
      )}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className={cn(
            "absolute -left-28 -top-16 h-[360px] w-[360px] rounded-full blur-[110px]",
            darkMode ? "bg-violet-500/25" : "bg-cyan-300/35",
          )}
        />
        <div
          className={cn(
            "absolute -right-20 top-[34%] h-[300px] w-[300px] rounded-full blur-[100px]",
            darkMode ? "bg-emerald-400/16" : "bg-indigo-300/30",
          )}
        />
        <div
          className={cn(
            "absolute -bottom-20 left-[20%] h-[280px] w-[280px] rounded-full blur-[100px]",
            darkMode ? "bg-sky-500/12" : "bg-violet-200/40",
          )}
        />
      </div>
      <PaymentCard
        darkMode={darkMode}
        onToggleTheme={() => setDarkMode((prev) => !prev)}
      />
    </div>
  );
}
