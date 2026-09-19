// test/node/accessPatterns.test.ts — the match patterns, as pure string work.
//
// Everything the extension may read is decided by these: which origin a tab belongs to,
// which of them the content script is registered on, and which tabs a withdrawal has to
// stop. A wrong pattern here is either a page Anagram reads without being asked or a
// prompt that asks for more than it needs, so the awkward cases are written down.
import { describe, expect, it } from "vitest";
import {
  ALL_SITES,
  DAEMON_ORIGINS,
  browsingOrigins,
  isAllSitesPattern,
  matchesAny,
  sitePattern,
  summarize,
} from "../../lib/access/patterns";

describe("the pattern for one site", () => {
  it("is the origin, and only the origin", () => {
    expect(sitePattern("https://example.com/a/b?c=d#e")).toBe("https://example.com/*");
    expect(sitePattern("http://news.example.co.uk/")).toBe("http://news.example.co.uk/*");
  });

  it("drops the port, because a match pattern has none", () => {
    // `http://localhost/*` is every port on that host — which is why the daemon's own
    // pattern needs no port either.
    expect(sitePattern("http://localhost:3000/app")).toBe("http://localhost/*");
    expect(sitePattern("https://example.com:8443/")).toBe("https://example.com/*");
  });

  it("asks for an internationalised domain the way the browser spells it", () => {
    expect(sitePattern("https://例え.jp/記事")).toBe("https://xn--r8jz45g.jp/*");
    expect(sitePattern("https://EXAMPLE.COM/A")).toBe("https://example.com/*");
  });

  it("covers a bare IPv4 host but not an IPv6 literal, which cannot be spelt", () => {
    expect(sitePattern("http://93.184.216.34/page")).toBe("http://93.184.216.34/*");
    expect(sitePattern("http://[::1]:8765/health")).toBeNull();
  });

  it("refuses everything no grant could ever cover", () => {
    for (const url of [
      "file:///Users/me/paper.pdf",
      "chrome://extensions",
      "about:blank",
      "moz-extension://abc/options.html",
      "chrome-extension://abc/options.html",
      "data:text/html,hi",
      "view-source:https://example.com/",
      "",
      undefined,
      "not a url",
    ]) {
      expect(sitePattern(url), String(url)).toBeNull();
    }
  });

  it("refuses the pages the browsers guard whatever is granted", () => {
    expect(sitePattern("https://chromewebstore.google.com/detail/x")).toBeNull();
    expect(sitePattern("https://addons.mozilla.org/en-US/firefox/")).toBeNull();
  });
});

describe("what a content script may be registered on", () => {
  it("never includes the daemon's own hosts", () => {
    // They are REQUIRED host permissions — the fetch that scores a paragraph — and a
    // content script on them would put Anagram on every page a local dev server (and
    // every test suite) serves, which nobody granted.
    expect(browsingOrigins(DAEMON_ORIGINS)).toEqual([]);
    expect(browsingOrigins([...DAEMON_ORIGINS, "https://example.com/*"])).toEqual([
      "https://example.com/*",
    ]);
  });

  it("is the all-sites pair once that has been granted — localhost included", () => {
    expect(browsingOrigins([...DAEMON_ORIGINS, ...ALL_SITES])).toEqual(ALL_SITES);
    expect(matchesAny(ALL_SITES, "http://localhost:57123/selftest.html")).toBe(true);
  });

  it("says nothing twice", () => {
    expect(browsingOrigins(["https://a.com/*", "https://a.com/*"])).toEqual(["https://a.com/*"]);
  });

  it("copes with no answer at all", () => {
    expect(browsingOrigins(undefined)).toEqual([]);
  });
});

describe("the summary the pages show", () => {
  it("counts granted sites, and says 'all' when the pair is there", () => {
    expect(summarize(DAEMON_ORIGINS)).toEqual({ all: false, sites: [] });
    expect(summarize([...DAEMON_ORIGINS, "https://a.com/*", "http://b.org/*"])).toEqual({
      all: false,
      sites: ["https://a.com/*", "http://b.org/*"],
    });
    expect(summarize([...DAEMON_ORIGINS, ...ALL_SITES, "https://a.com/*"])).toEqual({
      all: true,
      sites: ["https://a.com/*"],
    });
  });

  it("treats <all_urls> as all sites, whoever granted it", () => {
    expect(isAllSitesPattern("<all_urls>")).toBe(true);
    expect(summarize(["<all_urls>"]).all).toBe(true);
  });
});

describe("does a granted pattern cover this tab", () => {
  it("matches scheme, host and port the way the browser does", () => {
    expect(matchesAny(["https://example.com/*"], "https://example.com/deep/page?q=1")).toBe(true);
    expect(matchesAny(["https://example.com/*"], "http://example.com/")).toBe(false);
    expect(matchesAny(["https://example.com/*"], "https://sub.example.com/")).toBe(false);
    expect(matchesAny(["https://*.example.com/*"], "https://sub.example.com/")).toBe(true);
    expect(matchesAny(["https://*.example.com/*"], "https://example.com/")).toBe(true);
    expect(matchesAny(["http://localhost/*"], "http://localhost:8765/health")).toBe(true);
  });

  it("is false for the pages a tab can show that no pattern reaches", () => {
    expect(matchesAny(ALL_SITES, "chrome://extensions/")).toBe(false);
    expect(matchesAny(ALL_SITES, "file:///Users/me/x.pdf")).toBe(false);
    expect(matchesAny(ALL_SITES, undefined)).toBe(false);
    // A tab whose URL the extension may not read comes back without one at all — the
    // same answer, which is what makes the teardown pass safe.
    expect(matchesAny(["https://a.com/*"], "")).toBe(false);
  });

  it("never throws on a pattern it cannot parse", () => {
    expect(matchesAny(["nonsense", "https://*"], "https://example.com/")).toBe(false);
  });
});
