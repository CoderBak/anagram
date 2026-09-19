// test/node/siteSwitch.test.ts — the popup's "This site" switch tells the truth about a
// rule it inherited from a parent domain, and flipping it leaves exactly one rule (or none)
// saying what the user just asked for.
import { describe, expect, it } from "vitest";
import { isInherited, siteLine, switchWrite } from "../../entrypoints/popup/siteSwitch";
import type { SiteRule } from "../../lib/settings/settings";

const parent: SiteRule = { host: "zhihu.com", mode: "off" };
const parentOn: SiteRule = { ...parent, mode: "on" };
const exact: SiteRule = { host: "zhuanlan.zhihu.com", mode: "off" };
const HOST = "zhuanlan.zhihu.com";

describe("this-site switch", () => {
  it("names the site an inherited rule belongs to, and this host otherwise", () => {
    expect(siteLine(HOST, parent)).toBe("on zhihu.com");
    expect(siteLine(HOST, exact)).toBe("on zhuanlan.zhihu.com");
    expect(siteLine(HOST, null)).toBe("on zhuanlan.zhihu.com");
    // A rule stored under the www. twin of this host is the host's OWN rule.
    expect(isInherited("www.x.com", { host: "x.com", mode: "off" })).toBe(false);
    expect(siteLine("www.x.com", { host: "x.com", mode: "off" })).toBe("on www.x.com");
    expect(isInherited("news.x.com", { host: "www.x.com", mode: "off" })).toBe(true);
  });

  // The four combinations of what the parent rule says × what the global default says.
  // The user always asks for the opposite of what the switch shows, i.e. of the rule.
  it("removes an inherited rule the global default already replaces", () => {
    // off on zhihu.com, Anagram on everywhere → wanting it on needs no rule at all.
    expect(switchWrite(HOST, parent, true, true)).toEqual({ kind: "clear", host: "zhihu.com" });
    // on for zhihu.com, Anagram off everywhere → wanting it off needs no rule at all.
    expect(switchWrite(HOST, parentOn, false, false)).toEqual({ kind: "clear", host: "zhihu.com" });
  });

  it("writes the exact host when the global default would not give what was asked", () => {
    // off on zhihu.com, Anagram off everywhere → only a rule here can turn it on.
    expect(switchWrite(HOST, parent, false, true)).toEqual({ kind: "set", host: HOST, mode: "on" });
    // on for zhihu.com, Anagram on everywhere → only a rule here can turn it off.
    expect(switchWrite(HOST, parentOn, true, false)).toEqual({ kind: "set", host: HOST, mode: "off" });
  });

  it("writes this host's own rule when no rule, or its own, decides it", () => {
    expect(switchWrite(HOST, null, true, false)).toEqual({ kind: "set", host: HOST, mode: "off" });
    expect(switchWrite(HOST, null, false, true)).toEqual({ kind: "set", host: HOST, mode: "on" });
    // An exact rule is replaced, never cleared: the default it would fall back to is not
    // what the user came to this switch for.
    expect(switchWrite(HOST, exact, true, true)).toEqual({ kind: "set", host: HOST, mode: "on" });
    expect(switchWrite(HOST, { host: HOST, mode: "on" }, false, false)).toEqual({
      kind: "set",
      host: HOST,
      mode: "off",
    });
  });
});
