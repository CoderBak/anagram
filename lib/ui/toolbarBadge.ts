export interface BadgeApi {
  getBadgeText(details: { tabId: number }): Promise<string>;
  setBadgeText(details: { tabId: number; text: string }): Promise<void> | void;
  setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void> | void;
}

/** Keep the scan count behind copy feedback until the latest feedback expires. */
export function toolbarBadge(api?: BadgeApi) {
  const flashes = new Map<number, {
    original: Promise<string>;
    latestCount?: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const red = "#dc2626";
  function paint(tabId: number, text: string, color: string) {
    if (!api) return;
    // A browser can close the tab while its badge writes are in flight.
    void Promise.all([api.setBadgeText({ tabId, text }), api.setBadgeBackgroundColor({ tabId, color })]).catch(() => {});
  }
  return {
    count(tabId: number, flagged: number) {
      const text = flagged > 0 ? String(flagged) : "";
      const flash = flashes.get(tabId);
      if (flash) flash.latestCount = text;
      else paint(tabId, text, red);
    },
    feedback(tabId: number, copied: boolean) {
      if (!api) return;
      const previous = flashes.get(tabId);
      clearTimeout(previous?.timer);
      // The browser still has the displayed count when an idle worker wakes up.
      // Read it before replacing it. Repeated copies share that original reading.
      const original = previous?.original ?? api.getBadgeText({ tabId }).catch(() => "");
      const timer = setTimeout(async () => {
        const text = await original;
        const current = flashes.get(tabId);
        if (current?.timer !== timer) return;
        flashes.delete(tabId);
        paint(tabId, current.latestCount ?? (/^\d+$/.test(text) ? text : ""), red);
      }, 1500);
      flashes.set(tabId, { original, latestCount: previous?.latestCount, timer });
      paint(tabId, copied ? "✓" : "!", copied ? "#1a7f37" : red);
    },
    forget(tabId: number) {
      clearTimeout(flashes.get(tabId)?.timer);
      flashes.delete(tabId);
    },
  };
}
