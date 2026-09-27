// lib/access/commentFrames.ts — comment threads a page shows in a frame from another site.
//
// Disqus and Facebook's comments plugin put a page's whole comment thread in a frame of
// their own address, and utterances and giscus put a GitHub discussion there. A content
// script runs only in frames whose own origin is granted, so on a granted page such a thread
// went unread without a word: the panel now names the site and offers to allow it — the
// user's click, the browser's prompt, never a request by itself. Blogger is not here: its
// frame (`iframe#comment-editor`) is the form a reader types a comment into, and the
// comments are in the blog's own page. Pure string work, tested in
// test/node/commentFrames.test.ts.

interface Provider {
  /** The match pattern a grant asks for. */
  origin: string;
  /** What the panel and the settings page call it. */
  host: string;
  /** Is this frame address the provider's comment thread? */
  thread(url: URL): boolean;
}

const PROVIDERS: readonly Provider[] = [
  { origin: "https://disqus.com/*", host: "disqus.com", thread: (u) => u.hostname === "disqus.com" && u.pathname.startsWith("/embed/comments") },
  {
    origin: "https://www.facebook.com/*",
    host: "www.facebook.com",
    thread: (u) => u.hostname === "www.facebook.com" && /^\/(?:v\d+(?:\.\d+)?\/)?plugins\/comments(?:\.php)?$/.test(u.pathname),
  },
  { origin: "https://utteranc.es/*", host: "utteranc.es", thread: (u) => u.hostname === "utteranc.es" && u.pathname.startsWith("/utterances") },
  { origin: "https://giscus.app/*", host: "giscus.app", thread: (u) => u.hostname === "giscus.app" && /^\/(?:[\w-]+\/)?widget$/.test(u.pathname) },
];

/** The match pattern of the comment provider a frame at `src` belongs to, or null. */
export function commentOrigin(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return PROVIDERS.find((p) => p.thread(url))?.origin ?? null;
}

/** Is this a pattern a comment provider's grant asks for? Anything else is refused. */
export function isCommentOrigin(origin: string): boolean {
  return PROVIDERS.some((p) => p.origin === origin);
}

/** The name the panel and the settings page show for a provider's pattern. */
export function commentHost(origin: string): string {
  return PROVIDERS.find((p) => p.origin === origin)?.host ?? origin;
}

/** The pattern of a provider named by its host (the settings page's address), or null. */
export function commentOriginOfHost(host: string): string | null {
  return PROVIDERS.find((p) => p.host === host)?.origin ?? null;
}

/** The comment providers whose threads this document shows in frames, each once. */
export function commentOriginsIn(doc: Document): string[] {
  const found = new Set<string>();
  for (const frame of doc.querySelectorAll("iframe[src]")) {
    const origin = commentOrigin((frame as HTMLIFrameElement).src);
    if (origin) found.add(origin);
  }
  return [...found];
}
