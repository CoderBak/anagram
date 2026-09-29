// lib/ui/size.ts — sizes and times as the engine panels say them.
import { t, tn } from "../i18n";

/** A size in the units a download is counted in. */
export function formatSize(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6).toLocaleString()} MB`;
  return `${Math.max(0, Math.round(n / 1e3)).toLocaleString()} KB`;
}

/** The time a download has left, from its speed, in words. */
export function timeLeft(seconds: number): string {
  if (seconds < 60) return t("engineLeftUnderMinute");
  if (seconds < 3600) return tn("engineLeftMinutes", Math.ceil(seconds / 60));
  const minutes = Math.round(seconds / 60);
  return t("engineLeftHours", Math.floor(minutes / 60), minutes % 60);
}
