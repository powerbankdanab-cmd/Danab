import { NextResponse } from "next/server";
import { markOverdueRentals } from "@/lib/server/payment/rentals";

export async function GET() {
  try {
    await markOverdueRentals();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[OVERDUE_WORKER_FAILED]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export const dynamic = "force-dynamic";
