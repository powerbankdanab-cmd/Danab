import { NextRequest, NextResponse } from "next/server";
import { getPaymentTransaction } from "@/lib/server/payment/transactions";

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const transactionId = searchParams.get("transactionId");

        if (!transactionId) {
            return NextResponse.json({ error: "Missing transactionId" }, { status: 400 });
        }

        const transaction = await getPaymentTransaction(transactionId);

        if (!transaction) {
            return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
        }

        // Map backend status to frontend status
        let status: "pending" | "confirm_required" | "success" | "failed" = "pending";

        switch (transaction.status) {
            case "pending_payment":
                status = "pending";
                break;
            case "confirm_required":
                status = "confirm_required";
                break;
            case "captured":
                status = "success";
                break;
            case "failed":
                status = "failed";
                break;
            case "initiated":
            case "held":
            case "verified":
            case "capture_unknown":
            default:
                status = "pending";
        }

        return NextResponse.json({
            status,
            transactionId: transaction.id,
            battery_id: transaction.delivery?.batteryId,
            slot_id: transaction.delivery?.slotId,
        });
    } catch (error) {
        console.error("Status check error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}