import { getDb } from "@/lib/server/firebase-admin";

export async function isPhoneBlacklisted(phoneNumber: string) {
  const snapshot = await getDb()
    .collection("blacklist")
    .where("phoneNumber", "==", phoneNumber)
    .limit(1)
    .get();

  return !snapshot.empty;
}
