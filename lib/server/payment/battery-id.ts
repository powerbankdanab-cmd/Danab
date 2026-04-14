export function normalizeBatteryId(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();
}
