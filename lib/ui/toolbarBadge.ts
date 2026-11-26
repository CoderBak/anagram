export interface BadgeApi {
  setBadgeText(details: { tabId: number; text: string }): Promise<void> | void;
  setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void> | void;
}

/** Keep the scan count behind copy feedback until the latest feedback expires. */
export function toolbarBadge(api?: BadgeApi) {
  const counts = new Map<number, string>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const red = "#dc2626";
  function paint(tabId: number, text: string, color: string) {
    if (!api) return;
    // A browser can close the tab while its badge writes are in flight.
    void Promise.all([api.setBadgeText({ tabId, text }), api.setBadgeBackgroundColor({ tabId, color })]).catch(() => {});
  }
  return {
    count(tabId: number, flagged: number) {
      const text = flagged > 0 ? String(flagged) : "";
      counts.set(tabId, text);
      if (!timers.has(tabId)) paint(tabId, text, red);
    },
    feedback(tabId: number, copied: boolean) {
      clearTimeout(timers.get(tabId));
      paint(tabId, copied ? "✓" : "!", copied ? "#1a7f37" : red);
      timers.set(tabId, setTimeout(() => {
        timers.delete(tabId);
        paint(tabId, counts.get(tabId) ?? "", red);
      }, 1500));
    },
    forget(tabId: number) {
      clearTimeout(timers.get(tabId));
      timers.delete(tabId);
      counts.delete(tabId);
    },
  };
}
