// test/fakeTokens.mjs — how long a text is to the test fixtures' pretend model. The fake
// engine (test/fake-native.mjs) scores and counts with it, and the unit and vitest suites
// plan passes with it, so all of them agree on what a pass holds. Like a real tokenizer it
// never merges across a space: a word is a token per digit, as numbers are dense, and one
// per six characters of the rest — about 1.2 tokens an English word, as RoBERTa's are.
export function fakeTokens(text) {
  let tokens = 0;
  for (const word of text.split(/\s+/)) {
    const digits = (word.match(/\d/g) ?? []).length;
    tokens += digits + Math.ceil((word.length - digits) / 6);
  }
  return tokens;
}
