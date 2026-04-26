import { NextRequest, NextResponse } from "next/server";

import { isHttpError } from "@/lib/server/payment/errors";
import { getPaymentTransaction } from "@/lib/server/payment/transactions";
import { triggerUnlockIfNeeded } from "@/lib/server/payment/status";

export async function POST(request: NextRequest) {
    try {
        const body = (await request.json()) as { transactionId?: unknown };
        const transactionId =
            typeof body?.transactionId === "string" ? body.transactionId : null;

        if (!transactionId) {
            return NextResponse.json(
                { error: "Missing transactionId" },
                { status: 400 },
            );
        }

        const transaction = await getPaymentTransaction(transactionId);
        if (!transaction) {
            return NextResponse.json(
                { error: "Transaction not found" },
                { status: 404 },
            );
        }

        await triggerUnlockIfNeeded(transaction);

        const refreshed = await getPaymentTransaction(transactionId);
        if (!refreshed) {
            return NextResponse.json(
                { error: "Transaction not found" },
                { status: 404 },
            );
        }

        return NextResponse.json({
            transactionId,
            status: refreshed.status,
            unlockStarted: !!refreshed.unlockStarted,
        });
    } catch (error) {
        if (isHttpError(error)) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }

        console.error("payment_execute_error", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
