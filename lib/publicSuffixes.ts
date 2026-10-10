// lib/publicSuffixes.ts — where other people's sites are named below: the common second levels
// of country domains and the hosts that give each site a subdomain of its own. A limited list,
// not the Public Suffix List (thousands of entries); it covers most addresses one reads. Site
// rules stop inheriting at one (lib/settings/settings.ts), and the reading log's domains are
// named one label below one (lib/stats/coarsen.ts), so a site is the same site to both.
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // country second levels
  "com.ar", "gob.ar", "org.ar", "ac.at", "co.at", "gv.at", "or.at", "com.au", "edu.au", "gov.au",
  "id.au", "net.au", "org.au", "com.br", "gov.br", "net.br", "org.br", "ac.cn", "com.cn", "edu.cn",
  "gov.cn", "net.cn", "org.cn", "com.es", "org.es", "com.hk", "edu.hk", "gov.hk", "org.hk", "ac.id",
  "co.id", "go.id", "or.id", "ac.il", "co.il", "gov.il", "org.il", "ac.in", "co.in", "gov.in",
  "net.in", "org.in", "co.it", "ac.jp", "co.jp", "go.jp", "ne.jp", "or.jp", "ac.kr", "co.kr",
  "go.kr", "ne.kr", "or.kr", "com.mx", "gob.mx", "org.mx", "com.my", "edu.my", "org.my", "ac.nz",
  "co.nz", "govt.nz", "net.nz", "org.nz", "com.ph", "edu.ph", "org.ph", "com.pl", "org.pl", "com.ru",
  "com.sg", "edu.sg", "gov.sg", "com.tr", "edu.tr", "gov.tr", "org.tr", "com.tw", "edu.tw", "gov.tw",
  "org.tw", "com.ua", "org.ua", "ac.uk", "co.uk", "gov.uk", "ltd.uk", "me.uk", "net.uk", "org.uk",
  "plc.uk", "sch.uk", "com.vn", "co.za", "net.za", "org.za",
  // one site per subdomain
  "appspot.com", "azurewebsites.net", "blogspot.com", "cloudfront.net", "firebaseapp.com", "github.io",
  "gitlab.io", "glitch.me", "herokuapp.com", "medium.com", "neocities.org", "netlify.app",
  "notion.site", "pages.dev", "readthedocs.io", "repl.co", "s3.amazonaws.com", "substack.com",
  "translate.goog", "tumblr.com", "vercel.app", "web.app", "wordpress.com", "workers.dev",
]);
