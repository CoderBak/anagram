// test/node/lookalikes.test.ts — English disguised with Cyrillic and Greek look-alike letters
// (lib/dom/lookalikes.ts), and everything written in those alphabets, which stays as it is.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import DATA from "../../lib/dom/confusables.json";
import { foldLookalikes, hasLookalikes } from "../../lib/dom/lookalikes";
import { modelText } from "../../lib/dom/text";
import { blockText, readInWindows, unitVerdict, wordsOf, type WindowVerdict } from "../../lib/capture/windows";
import { coverageNote } from "../../lib/render/coverage";
import { t } from "../../lib/i18n";
import { SCRIPTS, SOURCE_SHA256, UNICODE_VERSION, table } from "../../scripts/confusables.mjs";
import type { ScoreBlock, ScoreResult } from "../../lib/contract";

/** What RAID's homoglyph attack does to a text: these letters, wherever they stand. */
const ATTACK: Record<string, string> = { a: "а", e: "е", o: "о", i: "і", c: "с", p: "р", y: "у", x: "х", I: "Ι", T: "Τ", A: "Α", H: "Н", M: "М", B: "Β", N: "Ν", P: "Р", C: "С", K: "К", E: "Ε", O: "О" };
const disguise = (s: string): string => s.replace(/[aeoicpyxITAHMBNPCKEO]/g, (ch) => ATTACK[ch]!);

const ENGLISH =
  "Hey everyone, I'm feeling very lost right now. When my ex broke no-contact last week, we had a long " +
  "conversation on the phone where it finally hit me how much they miss me, but how much I don't want to be " +
  "with them anymore. We have a baby and are still co-parenting, so I didn't think things would change this quickly.";
const RUSSIAN =
  "Вечером мы долго гуляли по старому городу. Узкие улицы были почти пустыми, только иногда мимо проезжал " +
  "трамвай, и его звонок отражался от каменных стен. Мы зашли в маленькое кафе на углу площади.";
const GREEK =
  "Το πρωί ξυπνήσαμε νωρίς για να προλάβουμε το πρώτο πλοίο για το νησί. Ο καιρός ήταν καθαρός και η θάλασσα " +
  "ήρεμη, οπότε το ταξίδι κράτησε λιγότερο από δύο ώρες. Ναι, όλα πήγαν καλά.";
/** Ukrainian typed with a Latin "i" for the Cyrillic one, as keyboards often leave it. */
const UKRAINIAN = "Мiсто прокидається рано. На ринку вже продають свiжi овочi, а справжнiй рiс є тiльки бiля входу.";

describe("the table", () => {
  it("is Unicode's, at the pinned version and hash, and what scripts/confusables.mjs writes", () => {
    expect(DATA.unicode).toBe(UNICODE_VERSION);
    expect(DATA.sha256).toBe(SOURCE_SHA256);
    expect(DATA.scripts).toEqual(SCRIPTS);
    expect(DATA.source).toBe(`https://www.unicode.org/Public/${UNICODE_VERSION}/security/confusables.txt`);
  });

  it("maps one letter of those alphabets to one ASCII letter or digit, so a fold keeps every offset", () => {
    const scripts = new RegExp(`^[${SCRIPTS.map((s) => `\\p{Script=${s}}`).join("")}]$`, "u");
    const entries = Object.entries(DATA.fold);
    expect(entries.length).toBeGreaterThan(150);
    expect(entries.length).toBeLessThan(300);
    for (const [from, to] of entries) {
      expect(from.length, from).toBe(1);
      expect(/\p{L}/u.test(from) && scripts.test(from), from).toBe(true);
      expect(to, from).toMatch(/^[A-Za-z0-9]$/);
    }
  });

  it("takes the member of a look-alike class that has the source's own case", () => {
    // confusables.txt sends Greek Ι, Cyrillic І and the digit 1 to "l", the class's prototype.
    const fold = DATA.fold as Record<string, string>;
    expect([fold["Ι"], fold["І"], fold["ӏ"], fold["О"], fold["о"], fold["З"]]).toEqual(["I", "I", "l", "O", "o", "3"]);
    const text = "0049 ;\t006C ;\tMA\t# ( I → l )\n0399 ;\t006C ;\tMA\t# ( Ι → l )\n04CF ;\t006C ;\tMA\t# ( ӏ → l )\n0031 ;\t006C ;\tMA\n";
    expect(table(text)).toEqual({ "Ι": "I", "ӏ": "l" });
  });
});

describe("folding", () => {
  it("gives a disguised English text its Latin letters back, whole look-alike words included", () => {
    expect(foldLookalikes(disguise(ENGLISH))).toBe(ENGLISH);
    expect(modelText(disguise(ENGLISH))).toBe(ENGLISH);
    // A Greek capital iota before an apostrophe, a lone Cyrillic "а", "Неу" in Cyrillic only.
    expect(foldLookalikes("Неу, Ι'm а fооl")).toBe("Hey, I'm a fool");
    expect(hasLookalikes(disguise(ENGLISH))).toBe(true);
  });

  it("leaves Russian, Greek and Ukrainian as written, a Latin letter slipped into a word included", () => {
    for (const text of [RUSSIAN, GREEK, UKRAINIAN, `${RUSSIAN} Mосква, Wi-Fi, iPhone'а.`]) {
      expect(foldLookalikes(text)).toBe(text);
      expect(modelText(text)).toBe(text);
      expect(hasLookalikes(text)).toBe(false);
    }
  });

  it("leaves an English text that quotes Russian or Greek, and the sciences' Greek letters", () => {
    for (const text of [
      'The Russian word "сор" means litter, and "не выносить сор из избы" keeps quarrels at home. The Greek "ναι" means yes.',
      "We measured the Hα and Hγ lines, fitted a Gaussian of width σ, and took the ν-dependence as a power law with index α; lnρ and dν follow.",
      "The αx term and σ2 dominate, while ρi stays small and Lyα is weak.",
    ]) {
      expect(foldLookalikes(text)).toBe(text);
      expect(modelText(text)).toBe(text);
    }
  });

  it("folds a Greek letter too once the text is disguised, and a Greek omicron is never a symbol", () => {
    expect(foldLookalikes("Thе αnswer is nο")).toBe("The answer is no");
    expect(foldLookalikes("Gο hοme")).toBe("Go home");
  });

  it("leaves Turkish dotless i, digits, emoji and joiners alone while it folds the word they sit in", () => {
    for (const text of ["Işık kırmızı ve ılık.", "Covid-19 👩‍💻 ❤️ 1️⃣ #️⃣ 🇯🇵"]) expect(foldLookalikes(text)).toBe(text);
    expect(foldLookalikes("Işık іs brіght, Cоvіd-19 👩‍💻 ❤️ 1️⃣")).toBe("Işık is bright, Covid-19 👩‍💻 ❤️ 1️⃣");
    // A word with a letter from outside the table is somebody's own spelling: "wоrд" is not folded.
    expect(foldLookalikes("the wоrд stays, the оther dоes nоt")).toBe("the wоrд stays, the other does not");
  });

  it("is a fixed point that keeps the length, on any mix of the two alphabets", () => {
    const letters = ["a", "e", "o", "i", "H", "I", "а", "е", "о", "і", "Н", "Ι", "ж", "α", "ν", "ο", "ı", "1", "З", " ", "'", "-", "́", "👩‍💻", "\n"];
    fc.assert(fc.property(fc.array(fc.constantFrom(...letters), { maxLength: 60 }), (parts) => {
      const text = parts.join("");
      const once = foldLookalikes(text);
      expect(once.length).toBe(text.length);
      expect(foldLookalikes(once)).toBe(once);
      const model = modelText(text);
      expect(modelText(model)).toBe(model);
    }), { numRuns: 2000, seed: 0x10CA1 });
  });

  it("removes a LaTeX span that was spelled with look-alikes, as it removes one that was not", () => {
    expect(modelText("the rate $\\аlphа$ grows")).toBe(modelText("the rate $\\alpha$ grows"));
  });
});

describe("reading in passes", () => {
  const LONG = Array.from({ length: 12 }, () => ENGLISH).join(" ");

  it("counts the words of a disguised text as the passes send them", () => {
    const folded = foldLookalikes(disguise(LONG));
    expect(wordsOf(folded).words.join(" ")).toBe(blockText(folded, { start: 0, end: folded.length }));
    // A lone Cyrillic "а" is folded for the company it keeps, which the word alone does not show.
    expect(wordsOf(folded).words).toContain("a");
  });

  it("does not fold a word on its own that its text leaves alone", () => {
    const { words } = wordsOf(UKRAINIAN);
    expect(words).toContain("рiс");
    expect(words.join(" ")).toBe(blockText(UKRAINIAN, { start: 0, end: UKRAINIAN.length }));
  });

  it("sends a disguised text's passes with the Latin letters back, at the offsets of the text on the page", async () => {
    const text = disguise(LONG);
    const sent: ScoreBlock[] = [];
    const score = async (blocks: ScoreBlock[]): Promise<Map<string, ScoreResult>> => {
      sent.push(...blocks);
      return new Map(blocks.map((b) => [b.id, { id: b.id, bucket: 0, probs: [1, 0, 0, 0], score: 0 }]));
    };
    const count = async (texts: string[]) => ({ alone: texts.map((w) => w.length), following: texts.map((w) => w.length) });
    const read = await readInWindows([{ id: "u", text, order: 0 }], score, count);
    const windows = read.get("u") as WindowVerdict[];
    expect(windows.length).toBeGreaterThan(1);
    for (const b of sent) expect(LONG).toContain(b.text);
    for (const w of windows) expect(modelText(text.slice(w.start, w.end))).toBe(modelText(LONG.slice(w.start, w.end)));
  });
});

describe("what the reader is told", () => {
  const verdict = unitVerdict("u", 100, [{ start: 0, end: 100, result: { id: "u", bucket: 0, probs: [1, 0, 0, 0], score: 0 } }]);

  it("the card of a disguised text says that its look-alike letters were replaced, and no other card does", () => {
    expect(t("coverageLookalikes")).toBe("Look-alike letters were replaced before scoring. ");
    expect(coverageNote(verdict, "paragraph", disguise(ENGLISH))).toContain(t("coverageLookalikes"));
    expect(coverageNote(verdict, "selection", disguise(ENGLISH))).toContain(t("coverageLookalikes"));
    for (const text of [ENGLISH, RUSSIAN, GREEK]) expect(coverageNote(verdict, "paragraph", text)).toBe("");
  });
});
