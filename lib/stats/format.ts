// lib/stats/format.ts — the statistics' numbers as the statistics page and the toolbar menu
// write them, in the browser's language: grouped words, whole percentages.
import { messageLocale } from "../i18n";

let formats: { locale: string; words: Intl.NumberFormat; percent: Intl.NumberFormat } | null = null;
function forLocale(): NonNullable<typeof formats> {
  const locale = messageLocale();
  if (formats?.locale !== locale) {
    formats = {
      locale,
      words: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      percent: new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }),
    };
  }
  return formats;
}

export function formatWords(n: number): string {
  return forLocale().words.format(Math.round(n));
}

/** A share as a whole percentage; one that is there but rounds to nothing says "<1%", and
 *  none at all (nothing scored) a dash. */
export function formatShare(x: number | null): string {
  const f = forLocale().percent;
  if (x === null) return "–";
  return x > 0 && x < 0.005 ? `<${f.format(0.01)}` : f.format(x);
}
