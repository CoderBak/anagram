// entrypoints/popup/siteSwitch.ts — what the popup's "This site" switch shows and writes.
//
// A per-site rule covers a whole site (lib/settings/settings.ts), so the rule that decides
// the open page may be stored on a PARENT domain: on zhuanlan.zhihu.com the switch can be
// off because of a rule written for zhihu.com. Three things follow — the switch has to show
// the rule that actually decides, the line under it has to name where that rule lives, and
// flipping it must not leave a rule behind that says the opposite of what the switch now
// shows. The decision is a pure function so every combination is provable without a browser.
import { normalizeRuleHost, type SiteMode, type SiteRule } from "../../lib/settings/settings";

/** Is this host decided by a rule stored on one of its PARENT domains? A rule stored under
 *  the same site (`x.com` vs `www.x.com`) is the host's own, not an inherited one. */
export function isInherited(host: string, rule: SiteRule | null): boolean {
  return rule !== null && normalizeRuleHost(rule.host) !== normalizeRuleHost(host);
}

/** The small line under "This site": the site the rule belongs to — this host, unless a
 *  parent domain's rule is what decides it. */
export function siteLine(host: string, rule: SiteRule | null): string {
  return `on ${isInherited(host, rule) ? rule!.host : host}`;
}

/** What flipping the switch does to the stored rules. */
export type SwitchWrite =
  | { kind: "clear"; host: string }
  | { kind: "set"; host: string; mode: SiteMode };

/**
 * Where the user's answer has to be written. An inherited rule that the global default
 * already agrees with is simply removed: the site then follows the default, and no rule is
 * left saying the opposite of what the switch shows. Otherwise the exact hostname gets its
 * own rule, which wins over the parent's for being more specific — and that is also what a
 * host with no rule at all, or with a rule of its own, has always got.
 */
export function switchWrite(
  host: string,
  rule: SiteRule | null,
  globalDefault: boolean,
  want: boolean,
): SwitchWrite {
  if (isInherited(host, rule) && globalDefault === want) return { kind: "clear", host: rule!.host };
  return { kind: "set", host, mode: want ? "on" : "off" };
}
