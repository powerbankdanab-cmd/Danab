import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";

/**
 * Internal API to clean up expired transaction events.
 * Runs periodically to control Firestore storage costs.
 */
export async function GET() {
  try {
    const db = getDb();
    const now = Date.now();
    
    // 1. Query for expired events
    const snapshot = await db
      .collection("transaction_events")
      .where("expiresAt", "<=", now)
      .limit(500) // Batch deletes to avoid timeout
      .get();

    if (snapshot.empty) {
      return NextResponse.json({ deleted: 0, message: "No expired events found" });
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();

    return NextResponse.json({
      deleted: snapshot.size,
      message: `Deleted ${snapshot.size} expired events`
    });
  } catch (error) {
    console.error("[CLEANUP_EVENTS_FAILED]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export const dynamic = "force-dynamic";
