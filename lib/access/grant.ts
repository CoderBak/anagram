// lib/access/grant.ts — what the extension's own pages do about site access.
//
// The popup, the onboarding page and the options page all ask the same two questions
// ("may we read this site?", "how much is granted?") and perform the same two acts, so
// they are written once here. Everything that follows a grant happens in the worker
// (lib/access/worker.ts): Chrome CLOSES the popup when a permission prompt opens, so a
// page cannot rely on being alive to see its own request answered.
//
// `requestAccess` must be called from inside the user's click, with nothing awaited
// before it — both browsers refuse a request that is not part of a user gesture.
import { browser } from "#imports";
import { ALL_SITES, summarize, type AccessSummary } from "./patterns";

/** What is granted right now, in the terms the pages show it in. */
export async function accessSummary(): Promise<AccessSummary> {
  try {
    return summarize((await browser.permissions.getAll()).origins);
  } catch {
    return { all: false, sites: [] };
  }
}

/** Is this exact origin pattern already granted (directly or by an all-sites grant)? */
export async function hasAccess(pattern: string | null): Promise<boolean> {
  if (!pattern) return false;
  try {
    return await browser.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/** Ask for origins. Call it FIRST in a click handler; the browser's prompt is the answer. */
export function requestAccess(origins: string[]): Promise<boolean> {
  return browser.permissions.request({ origins }).catch(() => false);
}

/** Give back every site: the all-sites grant and any single site granted on its own.
 *  Per-site RULES are untouched — they are settings, not access. */
export async function withdrawAccess(): Promise<boolean> {
  const { all, sites } = await accessSummary();
  const origins = [...(all ? ALL_SITES : []), ...sites];
  if (origins.length === 0) return true;
  return browser.permissions.remove({ origins }).catch(() => false);
}
