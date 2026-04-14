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
          ? "bg-gradient-to-b from-[#1a1333] via-[#1e1b2e] to-[#151520]"
          : "bg-gray-100",
      )}
    >
      {darkMode && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -left-32 -top-20 h-[420px] w-[420px] rounded-full bg-violet-600/20 blur-[100px]" />
          <div className="absolute -right-24 top-[40%] h-[300px] w-[300px] rounded-full bg-emerald-500/12 blur-[90px]" />
          <div className="absolute -bottom-16 left-[20%] h-[260px] w-[260px] rounded-full bg-indigo-500/15 blur-[80px]" />
        </div>
      )}
      <PaymentCard
        darkMode={darkMode}
        onToggleTheme={() => setDarkMode((prev) => !prev)}
      />
    </div>
  );
}
