import { browser } from "#imports";
import { IS_SAFARI } from "../surface";

export interface SafariBridge { home: string | null }
let reading: Promise<SafariBridge | null> | undefined;

/** The containing app answers without starting Python or downloading a model.
 * Temporary Safari extensions have no native app; they use the browser engine. */
export function safariBridge(): Promise<SafariBridge | null> {
  if (!IS_SAFARI) return Promise.resolve(null);
  return reading ??= new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    const finish = (value: SafariBridge | null): void => { clearTimeout(timer); resolve(value); };
    try {
      void browser.runtime.sendNativeMessage("dev.coderbak.Anagram", { anagram: "capabilities" }).then((value: unknown) => {
        const reply = value as { anagramNative?: unknown; home?: unknown } | null;
        finish(reply?.anagramNative === 1 && (reply.home === null || typeof reply.home === "string")
          ? { home: reply.home as string | null } : null);
      }, () => finish(null));
    } catch { finish(null); }
  });
}
