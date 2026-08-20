/** Small formatting helpers shared by the tabs and readout components. */

export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

export const fmt = (n: number | undefined, dec = 3) =>
  n !== undefined ? n.toFixed(dec) : "—";

/** Wall-clock time in IST, matching the CSV log's timestamp convention. */
export function tsToIST(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}
