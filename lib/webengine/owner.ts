/** Only the background may send inference/control requests to an engine document. */
export function engineOwner(sender: { id?: string; url?: string; tab?: unknown } | undefined, id: string, root: string): boolean {
  if (sender?.id !== id || sender.tab !== undefined) return false;
  // Chromium's service-worker sender may omit its URL.
  return !sender.url || ["background.js", "background.html", "_generated_background_page.html"].some((path) => sender.url === root + path);
}
