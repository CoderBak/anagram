// test/node/commentFrames.test.ts — comment threads a granted page shows from another site
// (lib/access/commentFrames.ts): which frames they are, what the offer asks for, and that
// the worker answers the offer's two questions only for them.
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { commentHost, commentOrigin, commentOriginOfHost, commentOriginsIn, isCommentOrigin } from "../../lib/access/commentFrames";
import { ALL_SITES, browsingOrigins, matchesAny } from "../../lib/access/patterns";
import { parseWorkerMessage, permitsMessage, type AccessSender } from "../../lib/access/messages";
import { ACTIONS } from "../../lib/messaging/protocol";

describe("comment frames", () => {
  it("knows the threads of Disqus, Facebook's comments plugin, utterances and giscus by their frame's address", () => {
    expect(commentOrigin("https://disqus.com/embed/comments/?base=default&f=blog&t_u=https%3A%2F%2Fexample.com%2Fpost")).toBe("https://disqus.com/*");
    expect(commentOrigin("https://www.facebook.com/plugins/comments.php?href=https%3A%2F%2Fexample.com%2F&numposts=5")).toBe("https://www.facebook.com/*");
    expect(commentOrigin("https://www.facebook.com/v2.10/plugins/comments.php?href=x")).toBe("https://www.facebook.com/*");
    expect(commentOrigin("https://www.facebook.com/v18.0/plugins/comments?href=x")).toBe("https://www.facebook.com/*");
    expect(commentOrigin("https://utteranc.es/utterances.html?src=https%3A%2F%2Futteranc.es%2Fclient.js&repo=a%2Fb")).toBe("https://utteranc.es/*");
    expect(commentOrigin("https://giscus.app/en/widget?origin=https%3A%2F%2Fexample.com")).toBe("https://giscus.app/*");
    expect(commentOrigin("https://giscus.app/widget?origin=x")).toBe("https://giscus.app/*");
  });

  it("offers nothing for the other frames those sites serve, nor for Blogger's comment form", () => {
    for (const src of [
      "https://disqus.com/",
      "http://disqusads.com/ads-iframe/adsnative/?x=1",
      "https://www.facebook.com/plugins/video.php?href=x",
      "https://www.facebook.com/plugins/like.php?href=x",
      "https://www.blogger.com/comment/frame/123?po=456",
      "https://www.blogger.com/navbar.g?targetBlogID=1",
      "https://www.youtube.com/embed/abc",
      "http://disqus.com/embed/comments/?f=x",
      "not a url",
    ]) {
      expect(commentOrigin(src), src).toBeNull();
    }
  });

  it("asks for patterns inside the optional all-sites grant, which the registration follows", () => {
    const origins = ["disqus.com", "www.facebook.com", "utteranc.es", "giscus.app"].map((host) => commentOriginOfHost(host)!);
    expect(origins.every(isCommentOrigin)).toBe(true);
    expect(browsingOrigins(origins)).toEqual(origins);
    for (const o of origins) expect(matchesAny(ALL_SITES, o.replace(/\*$/, "")), o).toBe(true);
    expect(origins.map(commentHost)).toEqual(["disqus.com", "www.facebook.com", "utteranc.es", "giscus.app"]);
    expect(isCommentOrigin("https://*/*")).toBe(false);
    expect(isCommentOrigin("https://example.com/*")).toBe(false);
    expect(commentOriginOfHost("example.com")).toBeNull();
  });

  it("finds each provider once among a page's frames", () => {
    const { document } = parseHTML(`<!doctype html><html><body>
      <iframe src="https://disqus.com/embed/comments/?f=a"></iframe>
      <iframe src="https://disqus.com/embed/comments/?f=b"></iframe>
      <iframe src="https://www.youtube.com/embed/x"></iframe>
      <div class="fb-comments"><span><iframe src="https://www.facebook.com/v2.8/plugins/comments.php?href=x"></iframe></span></div>
      <iframe id="comment-editor" src=""></iframe>
    </body></html>`);
    expect(commentOriginsIn(document as unknown as Document).sort()).toEqual(["https://disqus.com/*", "https://www.facebook.com/*"]);
  });
});

describe("the worker's two questions about them", () => {
  const session = "11111111-2222-4333-8444-555555555555";
  const top: AccessSender = { id: "ext", url: "https://example.com/post", tab: { id: 3, url: "https://example.com/post" }, frameId: 0 };
  const frame: AccessSender = { ...top, frameId: 7 };

  it("are asked by a page's top frame, about comment providers only", () => {
    const ask = parseWorkerMessage({ action: ACTIONS.COMMENT_ACCESS, session, origins: ["https://disqus.com/*"] });
    const open = parseWorkerMessage({ action: ACTIONS.OPEN_COMMENT_ACCESS, session, origin: "https://www.facebook.com/*" });
    expect(ask && permitsMessage("content", ask, top)).toBe(true);
    expect(open && permitsMessage("content", open, top)).toBe(true);
    expect(ask && permitsMessage("content", ask, frame)).toBe(false);
    expect(open && permitsMessage("popup", open, top)).toBe(false);
  });

  it("refuse any other site: a page cannot use them to learn what was granted, or to be offered anything", () => {
    expect(parseWorkerMessage({ action: ACTIONS.COMMENT_ACCESS, session, origins: ["https://example.org/*"] })).toBeNull();
    expect(parseWorkerMessage({ action: ACTIONS.COMMENT_ACCESS, session, origins: ["https://*/*"] })).toBeNull();
    expect(parseWorkerMessage({ action: ACTIONS.OPEN_COMMENT_ACCESS, session, origin: "https://bank.example/*" })).toBeNull();
    expect(parseWorkerMessage({ action: ACTIONS.COMMENT_ACCESS, session, origins: Array(9).fill("https://disqus.com/*") })).toBeNull();
  });
});
