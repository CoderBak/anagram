// test/node/anonymiseVocabulary.test.ts — what a diagnostics report may repeat of a
// class, an id or a test id. The end-to-end proof is in test/unit.mjs (a planted name in
// a real page, and not a four-character run of it in the report); these are the edges.
import { describe, expect, it } from "vitest";
import { wordy } from "../../lib/diagnostics/anonymise";
import { isKnownAtom } from "../../lib/diagnostics/vocabulary";

describe("the vocabulary", () => {
  it("knows the words our own detectors test for", () => {
    // lib/dom/boilerplate.ts decides a box is chrome by these; a report that could not
    // say them could not explain its own verdict.
    for (const atom of ["site", "nav", "byline", "paywall", "newsletter", "breadcrumb", "respond"]) {
      expect(isKnownAtom(atom), atom).toBe(true);
    }
    // The framework roots the orchestrator's hydration gate looks for.
    for (const atom of ["next", "gatsby", "nuxt", "docusaurus", "reactroot", "sveltekit"]) {
      expect(isKnownAtom(atom), atom).toBe(true);
    }
    // And the structural English a layout is built out of, in either number.
    for (const atom of ["article", "articles", "post", "posts", "card", "cards", "author", "avatar"]) {
      expect(isKnownAtom(atom), atom).toBe(true);
    }
  });

  it("knows nothing that could be somebody's name", () => {
    for (const atom of ["quillgrove", "marla", "heliotrope", "bracklethorpe", "acmecorp"]) {
      expect(isKnownAtom(atom), atom).toBe(false);
    }
  });
});

describe("wordy", () => {
  it("keeps the structure and drops the name, leaving its length behind", () => {
    expect(wordy("byline author-marla-quillgrove")).toBe("byline author-x5-x10");
    expect(wordy("postBody")).toBe("postBody");
    expect(wordy("quillgrovePanel")).toBe("x10Panel");
    expect(wordy("thread_quillgrove")).toBe("thread_x10");
  });

  it("drops a whole token that carries digits — generated, hashed or numbered", () => {
    expect(wordy("css-175oi2r")).toBe("");
    expect(wordy("sc-1f2a3b post")).toBe("post");
    expect(wordy("user-84523")).toBe("");
  });

  it("keeps a framework root, leading underscores and all", () => {
    expect(wordy("__next")).toBe("__next");
    expect(wordy("___gatsby")).toBe("___gatsby");
  });

  it("keeps at most six tokens, and nothing at all of nothing", () => {
    expect(wordy("post card item list row cell text")).toBe("post card item list row cell");
    expect(wordy("")).toBe("");
    expect(wordy(null)).toBe("");
  });
});
