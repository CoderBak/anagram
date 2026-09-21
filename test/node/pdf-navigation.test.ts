import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { createPdfNavigation } from "../../lib/pdf/navigation";
import { isInlinePdfResponse } from "../../lib/pdf/route";
const ticks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
beforeEach(() => fakeBrowser.reset()); afterEach(() => vi.restoreAllMocks());
function setup() {
  let before = (_: never) => {}, commit = (_: never) => {}, headers = (_: never) => {}, complete = (_: never) => {};
  let current = "https://example.test/document";
  vi.spyOn(fakeBrowser.webNavigation.onBeforeNavigate, "addListener").mockImplementation((f) => { before = f as never; });
  vi.spyOn(fakeBrowser.webNavigation.onCommitted, "addListener").mockImplementation((f) => { commit = f as never; });
  vi.spyOn(fakeBrowser.webNavigation.onCompleted, "addListener").mockImplementation((f) => { complete = f as never; });
  vi.spyOn(fakeBrowser.webRequest.onHeadersReceived, "addListener").mockImplementation((f) => { headers = f as never; });
  vi.spyOn(fakeBrowser.tabs, "get").mockImplementation((async () => ({id: 7, url: current})) as never);
  const open = vi.fn(async () => {}), access = vi.fn(async () => true), setting = vi.fn(async () => true);
  const route = createPdfNavigation({open, access, setting}); route.serve();
  const event = (extra = {}) => ({tabId: 7, frameId: 0, url: current, ...extra}) as never;
  return {route, open, access, setting, before: (url = current) => { current = url; before(event()); },
    headers: (extra = {}) => headers(event({type: "main_frame", method: "GET", statusCode: 200, responseHeaders: [{name: "Content-Type", value: "application/pdf"}], ...extra})),
    commit: (extra = {}) => commit(event(extra)), complete: () => complete(event()), move: (url: string) => { current = url; }};
}
describe("PDF navigation without content scripts", () => {
  it("opens authorized MIME PDFs with no filename extension after commit", async () => {
    const e = setup(); e.before(); e.headers(); await ticks(); expect(e.open).not.toHaveBeenCalled();
    e.commit(); await ticks(); expect(e.open).toHaveBeenCalledWith(7, "https://example.test/document", {auto: true});
    expect(await e.route.status(7)).toEqual({pdf: true, source: "https://example.test/document", local: false, authorized: true});
  });
  it("keeps native PDF when disabled or not persistently authorized", async () => {
    for (const disabled of ["setting", "access"] as const) {
      const e = setup(); e[disabled].mockResolvedValue(false); e.before(); e.headers(); e.commit(); await ticks(); expect(e.open).not.toHaveBeenCalled();
    }
  });
  it("routes authorized local PDFs without content injection", async () => {
    const e = setup(); e.before("file:///tmp/book.pdf"); e.commit(); await ticks();
    expect(e.open).toHaveBeenCalledWith(7, "file:///tmp/book.pdf", {auto: true});
  });
  it("suppresses every event for one Open original navigation, then allows reload", async () => {
    const e = setup(); e.route.pass(7, "https://example.test/document"); e.before(); e.headers(); e.commit(); e.complete();
    await e.route.contentPdf(7, "https://example.test/document", "navigate"); await ticks(); expect(e.open).not.toHaveBeenCalled();
    e.before(); e.headers(); e.commit(); await ticks(); expect(e.open).toHaveBeenCalledTimes(1);
  });
  it("leaves back/forward, POST and attachments untouched", async () => {
    const e = setup(); e.before(); e.headers(); e.commit({transitionQualifiers: ["forward_back"]}); await ticks(); expect(e.open).not.toHaveBeenCalled();
    e.before(); e.headers({method: "POST"}); e.commit(); await e.route.contentPdf(7, "https://example.test/document", "navigate"); await ticks(); expect(e.open).not.toHaveBeenCalled();
    e.before(); e.headers({responseHeaders: [{name: "content-type", value: "application/pdf"}, {name: "content-disposition", value: "attachment; filename=a.pdf"}]}); e.commit(); await ticks(); expect(e.open).not.toHaveBeenCalled();
  });
  it("does not navigate a replacement document after asynchronous authorization", async () => {
    const e = setup(); let allow!: (v: boolean) => void; e.access.mockImplementation(() => new Promise((r) => { allow = r; }));
    e.before(); e.headers(); e.commit(); await ticks(); e.before("https://example.test/new.html"); allow(true); await ticks(); expect(e.open).not.toHaveBeenCalled();
    expect((await e.route.status(7)).pdf).toBe(false);
  });
});
describe("response classification", () => {
  it("accepts case-insensitive PDF MIME parameters but not a substring or error response", () => {
    const facts = {method: "GET", statusCode: 200, responseHeaders: [{name: "CONTENT-TYPE", value: "Application/PDF; charset=binary"}]};
    expect(isInlinePdfResponse(facts)).toBe(true);
    expect(isInlinePdfResponse({...facts, statusCode: 404})).toBe(false);
    expect(isInlinePdfResponse({...facts, responseHeaders: [{name: "Content-Type", value: "application/pdf-malicious"}]})).toBe(false);
  });
});
