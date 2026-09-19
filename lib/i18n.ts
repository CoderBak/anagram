// lib/i18n.ts — the one way any of our code asks for a string.
//
// The browser picks the language, not us: `browser.i18n.getMessage` resolves the key
// against public/_locales/<the browser's UI language>/messages.json, falling back to
// `default_locale` ("en") by itself. There is no setting and no picker — a reader whose
// browser is in Chinese gets a Chinese extension, and everybody else gets English.
//
// WHY THE ENGLISH FILE IS ALSO IMPORTED. Two of our own harnesses run lib/ code with no
// extension APIs at all: test/unit-entry.ts is bundled by esbuild into an ordinary page,
// and the vitest suites import lib/ straight into Node. Neither has `browser.i18n`, and
// neither should have to gain one — so every lookup falls back to the English message
// compiled in here, and those suites keep reading exactly the English they always did.
// The same fallback covers a key the platform has no answer for (getMessage returns "").
// Only the messages travel in the bundle: wxt.config.ts strips the translator
// descriptions out of this import, which is most of the file's weight.
//
// Placeholders are the WebExtension positional kind — $1, $2 — and nothing else, so the
// substitution below and the platform's own agree to the character. A message never
// carries markup: where a sentence wraps a word in <code> or <strong>, the placeholder
// stands for an element the PAGE already holds (see lib/ui/localize.ts).
import EN from "../public/_locales/en/messages.json";

/** Every key in the English file — the union the whole codebase is checked against. */
export type MessageKey = keyof typeof EN;

/** `foo` for every `foo_one`/`foo_other` pair, which is what tn() takes. */
type BaseOf<K> = K extends `${infer B}_other` ? B : never;
export type PluralKey = BaseOf<MessageKey>;

interface I18nApi {
  getMessage(key: string, substitutions?: string[]): string;
}

/** The platform's i18n, or nothing at all outside an extension (tests, bundled pages). */
function platform(): I18nApi | undefined {
  const g = globalThis as { browser?: { i18n?: I18nApi }; chrome?: { i18n?: I18nApi } };
  return g.browser?.i18n ?? g.chrome?.i18n;
}

/** What the platform does to $1…$9 — done here for the English fallback. */
function fill(message: string, subs: string[]): string {
  if (subs.length === 0) return message;
  return message.replace(/\$([1-9])/g, (whole, d: string) => subs[Number(d) - 1] ?? whole);
}

/** One message, in the browser's UI language, English if there is nothing else. */
export function t(key: MessageKey, ...subs: (string | number)[]): string {
  const list = subs.map(String);
  try {
    const answer = platform()?.getMessage(key, list);
    // "" is the platform's way of saying it has no such message — fall through to ours.
    if (answer) return answer;
  } catch {
    /* an extension context that has just been invalidated — the English still works */
  }
  return fill(EN[key].message, list);
}

/**
 * A counted message. English needs two forms where it would otherwise grow an "s";
 * Chinese gives both forms the same text, which is exactly what a message file is for.
 * The count is always $1, so no caller has to pass it twice.
 */
export function tn(key: PluralKey, n: number, ...subs: (string | number)[]): string {
  return t(`${n === 1 ? `${key}_one` : `${key}_other`}` as MessageKey, n, ...subs);
}

/**
 * The BCP 47 tag of the messages that actually came back — "en" or "zh-CN". It is read
 * out of the message file itself rather than matched against getUILanguage(), so the
 * answer is whatever the platform resolved (a zh-TW browser lands wherever the platform's
 * own fallback puts it) and we never have to reimplement that matching.
 */
export function messageLocale(): string {
  return t("localeTag");
}
