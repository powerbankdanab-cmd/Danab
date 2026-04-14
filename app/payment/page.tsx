import { Suspense } from "react";

import { PaymentProcessingPage } from "@/components/payment/PaymentProcessingPage";

export default function PaymentPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white" />}>
      <PaymentProcessingPage />
    </Suspense>
  );
}
