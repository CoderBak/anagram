// lib/stats/worker.ts — the worker's half of the reading statistics: a page's numbers in,
// the day's records out.
//
// A page says how many words it read and what the model made of them, and nothing else
// (STATS_RECORD, validated in lib/access/messages.ts). WHERE they were read is the browser's
// to say: the site and the address come from the tab the browser names on the sender, the
// date from this worker's clock, and a private window from the tab's own flag. A page that
// claimed another site could not put its words there, and a private window's reading is
// never recorded at all. Nor is a site the reader switched Anagram off for, even where they
// asked for one page of it from the menu, nor Analyze text (the reader's own text: its page
// may not send this message).
//
// What is kept follows the level (lib/stats/record.ts). Retention runs at most once a day,
// on the first reading recorded that day or after the setting changed.
import type { WorkerMessage } from "../access/messages";
import type { ModelInfo } from "../contract";
import { ACTIONS } from "../messaging/protocol";
import { normalizeRuleHost } from "../settings/settings";
import { safePdfSource } from "../pdf/source";
import { addDays, localDate, localMinute, type RetentionDays, type StatsLevel } from "./model";
import { MAX_TITLE_CHARS, type Reading } from "./record";
import type { StatsStore } from "./store";

type StatsMessage = Extract<WorkerMessage, { action: typeof ACTIONS.STATS_RECORD }>;

export interface StatsSender {
  url?: string;
  frameId?: number;
  tab?: { url?: string; title?: string; incognito?: boolean };
}

export interface StatsRecorderDeps {
  store: StatsStore;
  level(): Promise<StatsLevel>;
  retention(): Promise<RetentionDays>;
  /** Whether Anagram is on for this hostname by the reader's settings; for a PDF from this
   *  computer (no hostname) the global switch. */
  enabledFor(hostname: string | null): Promise<boolean>;
  /** The model that answers now, or null before one is known. */
  model(): ModelInfo | null;
  now?(): Date;
}

/** Where words were read: the site, the address as it is recorded, and the hostname the
 *  reader's site rules are keyed on. */
interface Place {
  site: string;
  url: string;
  hostname: string | null;
}

/** An ordinary page: the tab's top-level address, http(s) only. A frame's words count for
 *  the page the frame is in, as its site rules do. */
function pagePlace(address: string | undefined): Place | null {
  try {
    const url = new URL(address ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { site: normalizeRuleHost(url.hostname), url: url.origin + url.pathname, hostname: url.hostname };
  } catch {
    return null;
  }
}

/** The PDF reader: the document it shows, by the `src` its own address carries; a file from
 *  this computer has no site and no address. */
function readerPlace(readerAddress: string | undefined): Place {
  let src: URL | null = null;
  try {
    src = safePdfSource(new URL(readerAddress ?? "").searchParams.get("src") ?? "");
  } catch { /* no address: a file */ }
  if (!src || src.protocol === "file:") return { site: "", url: "", hostname: null };
  return { site: normalizeRuleHost(src.hostname), url: src.origin + src.pathname, hostname: src.hostname };
}

const PRUNED = "pruned";

export function createStatsRecorder(deps: StatsRecorderDeps) {
  const now = deps.now ?? (() => new Date());
  /** One reading at a time: each is a read and a write of the same day's records. */
  let queue: Promise<unknown> = Promise.resolve();

  /** What this worker last pruned for, so a reading does not ask the database each time; the
   *  database remembers it across the worker's restarts. */
  let pruned = "";
  async function prune(today: string): Promise<void> {
    const days = await deps.retention();
    if (pruned === `${today} ${days}`) return;
    const last = (await deps.store.getMeta(PRUNED)) as { date?: string; days?: number } | undefined;
    if (last?.date !== today || last.days !== days) {
      await deps.store.prune(addDays(today, 1 - days));
      await deps.store.setMeta(PRUNED, { date: today, days });
    }
    pruned = `${today} ${days}`;
  }

  return {
    /** Add what a page read. Resolves to whether anything was recorded; a page is never told
     *  why not (it is answered the same either way). */
    record(msg: StatsMessage, sender: StatsSender, role: "content" | "reader"): Promise<boolean> {
      const run = queue.then(async () => {
        if (sender.tab?.incognito) return false;
        const level = await deps.level();
        if (level === "off") return false;
        const place = role === "reader" ? readerPlace(sender.url) : pagePlace(sender.tab?.url);
        if (!place || !(await deps.enabledFor(place.hostname))) return false;
        const at = now();
        const date = localDate(at);
        const reading: Reading = {
          date,
          minute: localMinute(at),
          site: place.site,
          url: place.url,
          title: (sender.tab?.title ?? "").trim().slice(0, MAX_TITLE_CHARS),
          kind: role === "reader" ? "document" : msg.kind,
          // The time a page was shown is the top frame's to say (or the reader's): a frame
          // is shown when its page is.
          dwell: role === "reader" || sender.frameId === 0 ? msg.dwell : 0,
          units: msg.units.map((u) => ({ words: u.w, probs: normalized(u.p) })),
          skipped: msg.skipped.map((s) => ({ words: s.w, why: s.why })),
          model: deps.model(),
        };
        await prune(date).catch(() => undefined);
        await deps.store.record(level, reading);
        return true;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** The probabilities as a distribution: what arrives sums to one within rounding. */
function normalized(p: readonly number[]): number[] {
  const sum = p.reduce((n, x) => n + x, 0);
  return sum > 0 ? p.map((x) => x / sum) : [0.25, 0.25, 0.25, 0.25];
}
