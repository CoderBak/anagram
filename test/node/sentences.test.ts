// test/node/sentences.test.ts — where a sentence starts (lib/dom/text.ts, sentenceStarts), the
// places a pass edge may move to (lib/capture/windows.ts). V8's Intl.Segmenter is the one in
// Chrome; it applies none of CLDR's abbreviation suppressions, so an edge could fall between
// "Mr." and the name after it.
import { describe, expect, it } from "vitest";
import { sentenceStarts } from "../../lib/dom/text";

/** The sentences `sentenceStarts` cuts `text` into, trimmed. */
function sentences(text: string): string[] {
  const cuts = [0, ...sentenceStarts(text), text.length];
  return cuts.slice(1).map((end, i) => text.slice(cuts[i], end).trim());
}

// pySBD's English "Golden Rules" (https://github.com/nipunsadvilkar/pySBD,
// tests/lang/test_english.py, MIT, Copyright (c) 2019 Nipun Sadvilkar), the ones about running
// prose. Left out: numbered and lettered list items, "Yahoo!", "N°.", bracketed ellipses in a
// citation, and the rules no suppression list can meet — "you and I." against "Albert I. Jones",
// "in the U.S. How" against "the U.S. Government".
const GOLDEN: [string, string[]][] = [
  ["Hello World. My name is Jonas.", ["Hello World.", "My name is Jonas."]],
  ["What is your name? My name is Jonas.", ["What is your name?", "My name is Jonas."]],
  ["There it is! I found it.", ["There it is!", "I found it."]],
  ["My name is Jonas E. Smith.", ["My name is Jonas E. Smith."]],
  ["Please turn to p. 55.", ["Please turn to p. 55."]],
  ["Were Jane and co. at the party?", ["Were Jane and co. at the party?"]],
  ["They closed the deal with Pitt, Briggs & Co. at noon.", ["They closed the deal with Pitt, Briggs & Co. at noon."]],
  ["Let's ask Jane and co. They should know.", ["Let's ask Jane and co.", "They should know."]],
  ["They closed the deal with Pitt, Briggs & Co. It closed yesterday.", ["They closed the deal with Pitt, Briggs & Co.", "It closed yesterday."]],
  ["I can see Mt. Fuji from here.", ["I can see Mt. Fuji from here."]],
  ["St. Michael's Church is on 5th st. near the light.", ["St. Michael's Church is on 5th st. near the light."]],
  ["That is JFK Jr.'s book.", ["That is JFK Jr.'s book."]],
  ["I visited the U.S.A. last year.", ["I visited the U.S.A. last year."]],
  ["I live in the E.U. How about you?", ["I live in the E.U.", "How about you?"]],
  ["I work for the U.S. Government in Virginia.", ["I work for the U.S. Government in Virginia."]],
  ["I have lived in the U.S. for 20 years.", ["I have lived in the U.S. for 20 years."]],
  ["She has $100.00 in her bag.", ["She has $100.00 in her bag."]],
  ["She has $100.00. It is in her bag.", ["She has $100.00.", "It is in her bag."]],
  [
    "He teaches science (He previously worked for 5 years as an engineer.) at the local University.",
    ["He teaches science (He previously worked for 5 years as an engineer.) at the local University."],
  ],
  ["Her email is Jane.Doe@example.com. I sent her an email.", ["Her email is Jane.Doe@example.com.", "I sent her an email."]],
  [
    "The site is: https://www.example.50.com/new-site/awesome_content.html. Please check it out.",
    ["The site is: https://www.example.50.com/new-site/awesome_content.html.", "Please check it out."],
  ],
  ["She turned to him, 'This is great.' she said.", ["She turned to him, 'This is great.' she said."]],
  ['She turned to him, "This is great." she said.', ['She turned to him, "This is great." she said.']],
  [
    'She turned to him, "This is great." She held the book out to show him.',
    ['She turned to him, "This is great."', "She held the book out to show him."],
  ],
  ["Hello!! Long time no see.", ["Hello!!", "Long time no see."]],
  ["Hello?? Who is there?", ["Hello??", "Who is there?"]],
  ["Hello!? Is that you?", ["Hello!?", "Is that you?"]],
  ["Hello?! Is that you?", ["Hello?!", "Is that you?"]],
  [
    "Thoreau argues that by simplifying one’s life, “the laws of the universe will appear less complex. . . .”",
    ["Thoreau argues that by simplifying one’s life, “the laws of the universe will appear less complex. . . .”"],
  ],
  ["I never meant that.... She left the store.", ["I never meant that....", "She left the store."]],
];

describe("sentenceStarts", () => {
  it.each(GOLDEN)("golden rule: %s", (text, want) => {
    expect(sentences(text)).toEqual(want);
  });

  it("starts no sentence after a title, an initial or an abbreviation before a name", () => {
    expect(sentences("Mr. Smith went to Washington. He liked it.")).toEqual(["Mr. Smith went to Washington.", "He liked it."]);
    expect(sentences("Dr. Jones arrived at noon. Then Gen. Adams spoke.")).toEqual(["Dr. Jones arrived at noon.", "Then Gen. Adams spoke."]);
    expect(sentences("The U.S. Army is large. It has many soldiers.")).toEqual(["The U.S. Army is large.", "It has many soldiers."]);
    expect(sentences("(Prof. Lindqvist) Roe v. Wade was decided in 1973. See Fig. 3 and pp. 12–14.")).toEqual([
      "(Prof. Lindqvist) Roe v. Wade was decided in 1973.",
      "See Fig. 3 and pp. 12–14.",
    ]);
  });

  it("keeps the break after a word that merely ends like one, and after a number abbreviation before a word", () => {
    expect(sentences("He left the FORMR. The rest stayed.")).toEqual(["He left the FORMR.", "The rest stayed."]);
    expect(sentences("She said no. Then she left.")).toEqual(["She said no.", "Then she left."]);
  });

  it("keeps the joint between two paragraphs whatever ends the first", () => {
    expect(sentenceStarts("We asked Mr.\n\nSmith answered.")).toEqual([14]);
  });

  it("still starts Chinese and Japanese sentences with nothing after the mark", () => {
    expect(sentences("第一句话。第二句话！第三句话？")).toEqual(["第一句话。", "第二句话！", "第三句话？"]);
  });
});
