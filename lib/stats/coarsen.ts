// lib/stats/coarsen.ts — a value at one layer of its dimension, from a finer one
// (lib/stats/config.ts). The worker applies these as it writes (what the reader chose to keep),
// and an export applies them again for a coarser file. Pure.
import { MIN_WORDS, MODEL_MIN_WORDS } from "../dom/text";
import type { Layer } from "./config";

// ---- time ---------------------------------------------------------------------------------

const MINUTE = 60_000;
/** An epoch time at TIME's layer: cut down to its second, minute, quarter hour, hour or day
 *  (local time, as the day a reading is filed under is). */
export function coarseTime(at: number, layer: Layer<"time">): number {
  if (layer === "ms") return Math.round(at);
  if (layer === "s") return Math.floor(at / 1000) * 1000;
  if (layer === "min") return Math.floor(at / MINUTE) * MINUTE;
  const d = new Date(at);
  if (layer === "quarter") d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  else if (layer === "hour") d.setMinutes(0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Durations double from a quarter second; past the last, "more". */
export const DUR_BINS = [250, 500, 1000, 2000, 4000, 8000, 16_000, 32_000, 64_000];
/** A duration or an offset at DUR's layer: whole ms, tenths of a second, seconds, the lower
 *  edge of its doubling bin, or null for none. */
export function coarseDur(ms: number, layer: Layer<"dur">): number | null {
  if (layer === "none") return null;
  if (layer === "ms") return Math.round(ms);
  if (layer === "decis") return Math.round(ms / 100) * 100;
  if (layer === "s") return Math.round(ms / 1000) * 1000;
  let bin = 0;
  for (const edge of DUR_BINS) if (ms >= edge) bin = edge;
  return bin;
}

// ---- place --------------------------------------------------------------------------------

/** Second-level labels under which a name is registered rather than a site, the common ones
 *  (the Public Suffix List has thousands; these cover most addresses one reads). */
const PUBLIC_SECOND = new Set([
  "co.uk", "ac.uk", "gov.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "ac.nz", "govt.nz", "co.za", "org.za",
  "com.br", "net.br", "org.br", "gov.br", "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn",
  "com.hk", "org.hk", "edu.hk", "gov.hk", "com.tw", "org.tw", "edu.tw", "gov.tw", "com.sg", "edu.sg", "gov.sg",
  "co.in", "net.in", "org.in", "ac.in", "gov.in", "co.kr", "or.kr", "ac.kr", "go.kr", "com.mx", "org.mx", "gob.mx",
  "com.ar", "org.ar", "gob.ar", "com.tr", "org.tr", "gov.tr", "edu.tr", "co.il", "org.il", "ac.il", "gov.il",
  "com.my", "org.my", "edu.my", "co.id", "or.id", "ac.id", "go.id", "com.ph", "org.ph", "edu.ph", "com.vn",
  "com.ua", "org.ua", "com.pl", "org.pl", "co.at", "or.at", "ac.at", "gv.at", "com.es", "org.es", "co.it",
  "github.io", "gitlab.io", "blogspot.com", "wordpress.com", "substack.com", "medium.com", "tumblr.com",
  "netlify.app", "vercel.app", "pages.dev", "web.app", "firebaseapp.com", "herokuapp.com", "azurewebsites.net",
  "appspot.com", "cloudfront.net", "s3.amazonaws.com", "readthedocs.io", "notion.site", "neocities.org",
]);

/** The name a host is registered under: its last two labels, three under a known public
 *  second level ("bbc.co.uk", "alice.github.io"). An address is its own. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(h) || h.includes(":")) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const two = labels.slice(-2).join(".");
  return PUBLIC_SECOND.has(two) ? labels.slice(-3).join(".") : two;
}

/** A path with what names one thing out of many left out: a segment with a digit in it, or
 *  longer than 24 characters, is ":id"; a hyphenated or underscored slug is ":slug". */
export function pathPattern(path: string): string {
  return path.split("/").map((segment) => {
    if (segment === "") return segment;
    let s = segment;
    try { s = decodeURIComponent(segment); } catch { /* as it is */ }
    if (/\d/.test(s) || s.length > 24) return ":id";
    if (/[-_+ ]/.test(s) && s.split(/[-_+ ]+/).length >= 3) return ":slug";
    return segment;
  }).join("/");
}

/** Each layer of PLACE for an address, finest first; null where a layer has nothing. */
export function placeLadder(address: string): Record<Exclude<Layer<"place">, "none">, string> | null {
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const names = [...new Set([...url.searchParams.keys()])];
  const host = url.hostname.replace(/^www\./, "");
  return {
    url: url.href,
    nofragment: url.origin + url.pathname + url.search,
    querynames: url.origin + url.pathname + (names.length ? `?${names.join("&")}` : ""),
    path: url.origin + url.pathname,
    pattern: url.origin + pathPattern(url.pathname),
    host,
    domain: registrableDomain(host),
  };
}

// ---- text and length ---------------------------------------------------------------------

/** A title at TITLE's layer. */
export function coarseTitle(title: string, layer: Layer<"title">): string | undefined {
  if (layer === "none") return undefined;
  const t = title.trim();
  return layer === "short" ? t.slice(0, 60) : t.slice(0, 300);
}

/** The length bands: under the minimum, under the model's training minimum, then doubling. */
export const LEN_BANDS = [MIN_WORDS, MODEL_MIN_WORDS, 150, 300, 600];
export function lenBand(words: number): string {
  if (words < LEN_BANDS[0]!) return `<${LEN_BANDS[0]}`;
  for (let i = 1; i < LEN_BANDS.length; i++) if (words < LEN_BANDS[i]!) return `${LEN_BANDS[i - 1]}-${LEN_BANDS[i]! - 1}`;
  return `${LEN_BANDS.at(-1)}+`;
}

export interface Lengths { chars?: number; sent?: number; words: number; tokens?: number; sentences?: number; lines?: number; pieces?: number[]; formulas?: number; windows?: number; band?: string }
/** A paragraph's lengths at LEN's layer, or undefined for none. */
export function coarseLen(len: Lengths, layer: Layer<"len">): Lengths | undefined {
  if (layer === "none") return undefined;
  if (layer === "all") return len;
  if (layer === "words") return { words: len.words, ...(len.tokens !== undefined ? { tokens: len.tokens } : {}) };
  if (layer === "rounded") return { words: Math.round(len.words / 5) * 5 };
  return { words: 0, band: lenBand(len.words) };
}

// ---- verdict ------------------------------------------------------------------------------

export interface VerdictFields { p?: number[]; score?: number; band?: number; argmax?: number; flagged?: boolean; doubt?: boolean; windows?: number[][]; tokens?: number; truncated?: boolean }
const r2 = (x: number): number => Math.round(x * 100) / 100;
/** A verdict at VERDICT's layer. */
export function coarseVerdict(v: VerdictFields, layer: Layer<"verdict">): VerdictFields | undefined {
  if (layer === "none") return undefined;
  if (layer === "probs") return v;
  if (layer === "probs2") return { ...v, p: v.p?.map(r2), score: v.score === undefined ? undefined : r2(v.score), windows: v.windows?.map((w) => w.map(r2)) };
  if (layer === "words") return { band: v.band, argmax: v.argmax, flagged: v.flagged, doubt: v.doubt };
  return { flagged: v.flagged };
}

export interface LangFields { label?: string; prob?: number; script?: string; english?: boolean }
export function coarseLang(l: LangFields, layer: Layer<"lang">): LangFields | undefined {
  if (layer === "none") return undefined;
  if (layer === "full") return l;
  if (layer === "label") return { label: l.label };
  return { english: l.english ?? l.label === "en" };
}
