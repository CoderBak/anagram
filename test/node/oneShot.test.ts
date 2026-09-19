// test/node/oneShot.test.ts — which settings change ends a one-shot ("Analyze this page")
// run. The reason the baseline exists: the likeliest page to reach for that menu entry on
// is one whose site rule ALREADY says "off", so the presence of an off rule proves nothing
// and only a change to it may stop the run.
import { describe, expect, it } from "vitest";
import { NO_RULE, oneShotEnds, ruleState } from "../../lib/settings/oneShot";

const off = (host: string) => ruleState({ host, mode: "off" as const });
const on = (host: string) => ruleState({ host, mode: "on" as const });

describe("a one-shot run and the settings", () => {
  it("survives every change that does not turn this site off", () => {
    // No rule at the start, none now: the global default went off — not this site.
    expect(oneShotEnds(NO_RULE, NO_RULE)).toBe(false);
    // Another site's rule was written; this one is still decided by nothing.
    expect(oneShotEnds(NO_RULE, NO_RULE)).toBe(false);
    // A rule that turns this site ON cannot end a run.
    expect(oneShotEnds(NO_RULE, on("example.com"))).toBe(false);
    expect(oneShotEnds(off("example.com"), on("news.example.com"))).toBe(false);
  });

  it("ignores the off rule the run was started under", () => {
    // The site was already off — that rule is why the menu entry was used at all.
    expect(oneShotEnds(off("example.com"), off("example.com"))).toBe(false);
    // Stored under the www. twin of the same site: still that same rule.
    expect(oneShotEnds(off("www.example.com"), off("example.com"))).toBe(false);
  });

  it("ends when this site is turned off during the run", () => {
    expect(oneShotEnds(NO_RULE, off("example.com"))).toBe(true);
    expect(oneShotEnds(on("example.com"), off("example.com"))).toBe(true);
    // The panel's footer writing the exact host under a parent domain's off rule: a
    // different, more specific rule is what turns the site off now.
    expect(oneShotEnds(off("example.com"), off("news.example.com"))).toBe(true);
  });

  it("reads a stored rule into the state it compares", () => {
    expect(ruleState(null)).toEqual({ host: null, mode: null });
    expect(ruleState({ host: "www.X.com", mode: "off" })).toEqual({ host: "x.com", mode: "off" });
  });
});
