// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a
// copy of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// The containers consent platforms draw their cookie banners in, as DuckDuckGo autoconsent
// names them: https://github.com/duckduckgo/autoconsent (version 16.42.0), MPL-2.0,
// copyright Sam Macbeth, DuckDuckGo and the autoconsent contributors. Taken from its rules
// (rules/autoconsent/<name>.json, or lib/cmps/<name>.ts where the rule is code): mostly the
// `prehideSelectors`, which autoconsent hides on every page it runs on until it knows which
// platform is there — so none of them names anything but a banner — and otherwise the
// container its `detectCmp` takes as proof that the platform is present. Only containers are
// kept, never a button or an action. Platforms whose container our class tokens already catch
// (OneTrust's #onetrust-consent-sdk, Google's .fc-consent-root, CookieYes, Moove, TrustArc's
// bar) are left out.

export const CONSENT_BANNER_SELECTORS: readonly string[] = [
  "#CybotCookiebotDialog", "#cookiebanner", "#CookieBanner", // cookiebot.ts
  "#didomi-host", // didomi
  "#qc-cmp2-container", // quantcast
  "#usercentrics-root", "#usercentrics-cmp-ui", // usercentrics-api
  "#iubenda-cs-banner", // iubenda
  "#cmplz-cookiebanner-container", // complianz-banner
  '[aria-describedby="cookieconsent:desc"]', // complianz-optin and the other cookieconsent rules
  ".osano-cm-window", // osano
  "#cmpbox", "#cmpbox2", "#cmpwrapper", // consentmanager.ts
  "#ncmp__tool .ncmp__banner", // consentmanager-ncmp
  ".trustarc-banner-container", ".truste_box_overlay", ".truste_popframe", // trustarc-top.ts
  "#termly-code-snippet-support", // termly
  "#cookiefirst-root", ".cookiefirst-root", // cookiefirst.com
  ".axeptio_mount", // axeptio
  "#BorlabsCookieBox", ".brlbs-cmpnt-dialog", // borlabs
  "#cookiescript_injected", // cookie-script
  ".ch2-container", // cookiehub
  "#tarteaucitronRoot", // tarteaucitron.js
  "#sd-cmp", // sirdata
  "#pubtech-cmp", // pubtech
  "#fides-overlay", // fides
  "#ketch-banner", "#ketch-modal", "#lanyard_root div[role='dialog']", // ketch
  "#_evidon_banner", // evidon.ts
  "#__tealiumGDPRecModal", "#__tealiumGDPRcpPrefs", "#__tealiumImplicitmodal", // tealium
  "#ccc-module", "#ccc-notify", // civic-cookie-control
  'div[consent-skip-blocker="1"][id][data-bg]', // real-cookie-banner
  "#shopify-pc__banner", // shopify
  '[data-comp-type="cookie-banner-root-wix"]', '[data-hook="ccsu-banner-wrapper"]', // wix
  ".termsfeed-com---nb", ".cc_dialog.cc_css_reboot", // termsfeed, termsfeed3
  "#wcpConsentBannerCtrl", // microsoft
  "#cc--main", "#cc-main", // cookieconsent2, cookieconsent3
];

/**
 * Hosts that serve a consent platform's banner or its settings in a FRAME of their own, with
 * the platform's text in it: Sourcepoint's message CDN and its CCPA hosts (sourcepoint-frame.ts
 * names ccpa-notice and ccpa-pm.sp-prod.net), LiveRamp's cmp-consent-tool.privacymanager.io
 * (privacymanager.json) and the amp-consent-tool beside it, TrustArc's consent manager — the
 * `.truste_popframe` of trustarc-top.ts — AppConsent's `iframe[title='Consent window']`
 * (appconsent.json), and Google's Funding Choices messages, which amp-consent frames. A host
 * listed without a leading dot is matched exactly, one with a dot with all its subdomains.
 */
const CONSENT_FRAME_HOSTS: readonly string[] = [
  ".privacy-mgmt.com", ".sp-prod.net",
  ".privacymanager.io",
  "consent-pref.trustarc.com", "consent.trustarc.com",
  ".appconsent.io",
  "fundingchoicesmessages.google.com",
];

/** Sourcepoint serves its messages from the publisher's own domain as well (a CNAME such as
 *  `sourcepoint.<site>`), and there the page is known by its address: one of these paths with
 *  a message or consent id in the query (sourcepoint-frame.ts, `detectCmp`). */
const SOURCEPOINT_PATHS = new Set(["/index.html", "/privacy-manager/index.html", "/ccpa_pm/index.html", "/us_pm/index.html"]);
const SOURCEPOINT_PARAMS = ["message_id", "requestUUID", "consentUUID"];

/** What a consent platform draws inside a frame it gives no address of its own: Piano's
 *  banner (piano.io.json). */
const CONSENT_FRAME_CONTENT = "#piano-cookie_banner";

/**
 * Is this frame a consent platform's banner or settings page? With every site granted the
 * content script runs in each frame of a page, and a frame of consent text is as long as any
 * article paragraph. Asked by the frame of itself, before anything is read.
 */
export function isConsentFrame(url: URL | Location, doc?: Document): boolean {
  const host = url.hostname.toLowerCase();
  if (CONSENT_FRAME_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) || host === h.slice(1) : host === h))) return true;
  if (SOURCEPOINT_PATHS.has(url.pathname)) {
    const query = new URLSearchParams(url.search);
    if (SOURCEPOINT_PARAMS.some((p) => query.has(p))) return true;
  }
  return !!doc && doc.querySelector(CONSENT_FRAME_CONTENT) !== null;
}
