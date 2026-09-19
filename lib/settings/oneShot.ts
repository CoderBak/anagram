// lib/settings/oneShot.ts — when a settings change ends a one-shot run.
//
// "Analyze this page with Anagram" runs on a page the settings say no to, and that run
// belongs to the page: an unrelated write — another site's rule, the global default —
// must not silence it, while the user turning THIS site off must. The two are told apart
// by what the rules said when the run began, because the most common reason to reach for
// the menu entry is a site that was ALREADY off: "there is an off rule" is therefore no
// evidence at all, and only a change to it is. The comparison is a pure function so the
// cases can be proven without a browser.
import { normalizeRuleHost, type SiteRule } from "./settings";

/** The rule deciding a host, reduced to what a one-shot run cares about. */
export interface RuleState {
  /** Normalized hostname the deciding rule is stored under; null when no rule covers it. */
  host: string | null;
  mode: "on" | "off" | null;
}

export const NO_RULE: RuleState = { host: null, mode: null };

export function ruleState(rule: SiteRule | null): RuleState {
  return rule ? { host: normalizeRuleHost(rule.host), mode: rule.mode } : NO_RULE;
}

/**
 * Does this settings change end the run? Only a rule that turns this site off — and only
 * when that is new: either the site was not off when the run started, or a different,
 * more specific rule is turning it off now (the panel's footer writing the exact host
 * under a parent domain's rule).
 */
export function oneShotEnds(started: RuleState, now: RuleState): boolean {
  if (now.mode !== "off") return false;
  if (started.mode !== "off") return true;
  return now.host !== started.host;
}
