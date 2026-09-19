// test/node/siteRules.test.ts — a per-site rule covers the SITE: the exact hostname, then
// each parent domain, most specific first, with a leading "www." absent on both sides.
// Rules already in storage (any spelling) keep deciding what they always decided.
import { describe, expect, it, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import {
  settings,
  clearSiteOverride,
  effectiveRule,
  enabledForSite,
  normalizeRuleHost,
  setSiteOverride,
  type SiteMode,
} from "../../lib/settings/settings";

beforeEach(() => fakeBrowser.reset());

/** Seed the stored rules exactly as an earlier version would have written them. */
const stored = (rules: Record<string, SiteMode>): Promise<void> =>
  fakeBrowser.storage.local.set({ siteOverrides: rules });

describe("site rules", () => {
  it("applies a rule to every subdomain of the site it was written for", async () => {
    await stored({ "zhihu.com": "off" });
    expect(await enabledForSite("zhihu.com")).toBe(false);
    expect(await enabledForSite("www.zhihu.com")).toBe(false);
    expect(await enabledForSite("zhuanlan.zhihu.com")).toBe(false);
    expect(await enabledForSite("v2.api.zhuanlan.zhihu.com")).toBe(false);
    expect(await enabledForSite("zhihu.com.evil.example")).toBe(true); // not a subdomain
    expect(await enabledForSite("notzhihu.com")).toBe(true);
  });

  it("lets the exact host beat its parent, whichever way round the two rules point", async () => {
    await stored({ "example.com": "off", "docs.example.com": "on" });
    expect(await enabledForSite("docs.example.com")).toBe(true);
    expect(await enabledForSite("www.docs.example.com")).toBe(true);
    expect(await enabledForSite("example.com")).toBe(false);
    expect(await enabledForSite("blog.example.com")).toBe(false);

    await stored({ "example.com": "on", "ads.example.com": "off" });
    await settings.enabled.setValue(false);
    expect(await enabledForSite("example.com")).toBe(true);
    expect(await enabledForSite("ads.example.com")).toBe(false);
  });

  it("takes the most specific of several rules on one site", async () => {
    await stored({ "example.com": "off", "b.example.com": "on", "c.example.com": "off" });
    expect(await enabledForSite("a.b.example.com")).toBe(true);
    expect((await effectiveRule("a.b.example.com"))!.host).toBe("b.example.com");
    expect(await enabledForSite("a.c.example.com")).toBe(false);
    expect(await enabledForSite("a.d.example.com")).toBe(false);
  });

  it("treats a leading www. as absent on both sides", async () => {
    await stored({ "www.x.com": "off" });
    expect(await enabledForSite("x.com")).toBe(false);
    expect(await enabledForSite("www.x.com")).toBe(false);
    expect(await enabledForSite("mobile.x.com")).toBe(false);

    await stored({ "y.com": "off" });
    expect(await enabledForSite("www.y.com")).toBe(false);
    expect(await enabledForSite("www.sub.y.com")).toBe(false);
  });

  it("names the hostname a rule is STORED under, so a caller can clear the right one", async () => {
    await stored({ "www.x.com": "off" });
    expect(await effectiveRule("news.x.com")).toEqual({ host: "www.x.com", mode: "off" });
    await clearSiteOverride((await effectiveRule("news.x.com"))!.host);
    expect(await effectiveRule("news.x.com")).toBeNull();
    expect(await settings.siteOverrides.getValue()).toEqual({});
  });

  it("never climbs to a bare public suffix", async () => {
    await stored({ "co.uk": "off", "com": "off", "github.io": "off", "com.cn": "off" });
    expect(await enabledForSite("example.co.uk")).toBe(true);
    expect(await enabledForSite("shop.example.co.uk")).toBe(true);
    expect(await enabledForSite("example.com")).toBe(true);
    expect(await enabledForSite("alice.github.io")).toBe(true);
    expect(await enabledForSite("example.com.cn")).toBe(true);
    // The guard stops the CLIMB; a rule written on that name still governs it exactly.
    expect(await enabledForSite("github.io")).toBe(false);
    // One level below a guarded suffix is an ordinary site, subdomains included.
    await stored({ "example.co.uk": "off" });
    expect(await enabledForSite("shop.example.co.uk")).toBe(false);
  });

  it("matches IP addresses and localhost exactly and nothing else", async () => {
    await stored({ "127.0.0.1": "off", "0.0.1": "off", "localhost": "off", "[::1]": "off" });
    expect(await enabledForSite("127.0.0.1")).toBe(false);
    expect(await enabledForSite("localhost")).toBe(false);
    expect(await enabledForSite("[::1]")).toBe(false);
    // 127.0.0.1 must not be read as a subdomain of 0.0.1, nor app.localhost of localhost.
    expect(await enabledForSite("127.0.0.2")).toBe(true);
    expect(await enabledForSite("app.localhost")).toBe(true);
    expect(await enabledForSite("192.168.0.1")).toBe(true);
  });

  it("writes the hostname it is given and lets that rule decide from then on", async () => {
    await settings.enabled.setValue(true);
    await setSiteOverride("news.example.com", "off");
    expect(await settings.siteOverrides.getValue()).toEqual({ "news.example.com": "off" });
    expect(await enabledForSite("news.example.com")).toBe(false);
    expect(await enabledForSite("example.com")).toBe(true); // a subdomain rule climbs nowhere
    await setSiteOverride("news.example.com", "on");
    expect(await settings.siteOverrides.getValue()).toEqual({ "news.example.com": "on" });
  });

  it("falls back to the global flag when no rule covers the host", async () => {
    expect(await enabledForSite("example.com")).toBe(true);
    await settings.enabled.setValue(false);
    expect(await enabledForSite("example.com")).toBe(false);
    expect(await effectiveRule("example.com")).toBeNull();
    await stored({ "example.com": "on" });
    expect(await enabledForSite("example.com")).toBe(true);
    expect(await enabledForSite("other.example")).toBe(false);
  });

  it("normalizes a pasted address to the hostname a rule is keyed on", () => {
    expect(normalizeRuleHost("WWW.Example.COM")).toBe("example.com");
    expect(normalizeRuleHost("example.com.")).toBe("example.com");
    expect(normalizeRuleHost("  x.com  ")).toBe("x.com");
    expect(normalizeRuleHost("wwwx.com")).toBe("wwwx.com");
  });
});
