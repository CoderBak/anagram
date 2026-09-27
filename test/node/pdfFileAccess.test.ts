import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { FILE_ORIGIN, getFileAccess, legacyFirefoxFileAccess, requestFileAccess } from "../../lib/pdf/fileAccess";

describe("local PDF authorization", () => {
  beforeEach(() => fakeBrowser.reset());

  it("does not treat website grants as local file access", async () => {
    vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(false as never);
    vi.spyOn(fakeBrowser.extension, "isAllowedFileSchemeAccess").mockResolvedValue(true as never);
    expect(await getFileAccess()).toEqual({ granted: false, allowed: true });
    expect(fakeBrowser.permissions.contains).toHaveBeenCalledWith({ origins: [FILE_ORIGIN] });
  });

  it("requires Chrome's separate file switch even when the origin is granted", async () => {
    vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(true as never);
    vi.spyOn(fakeBrowser.extension, "isAllowedFileSchemeAccess").mockResolvedValue(false as never);
    // Chrome has no runtime.getBrowserInfo, and neither has WXT's fake browser.
    expect(await getFileAccess()).toEqual({ granted: true, allowed: false });
  });

  it("limits the Firefox legacy exception to known supported old versions", () => {
    expect(legacyFirefoxFileAccess({ name: "Firefox", version: "140.14.0" })).toBe(true);
    expect(legacyFirefoxFileAccess({ name: "Firefox", version: "152.0" })).toBe(true);
    for (const info of [undefined, {name:"Chrome",version:"145"}, {name:"Firefox",version:"153.0"}, {name:"Firefox",version:"invalid"}]) {
      expect(legacyFirefoxFileAccess(info)).toBe(false);
    }
  });

  it("requests only file access and leaves a refusal refused", async () => {
    vi.spyOn(fakeBrowser.permissions, "request").mockResolvedValue(false as never);
    expect(await requestFileAccess()).toBe(false);
    expect(fakeBrowser.permissions.request).toHaveBeenCalledWith({ origins: [FILE_ORIGIN] });
  });
});
