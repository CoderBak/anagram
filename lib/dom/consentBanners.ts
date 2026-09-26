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
