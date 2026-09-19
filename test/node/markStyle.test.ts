// test/node/markStyle.test.ts — what an old profile's mark style reads as.
import { describe, expect, it } from "vitest";
import { normalizeMarkStyle } from "../../lib/settings/settings";

describe("a stored mark style, read by this build", () => {
  it("keeps the two styles there are now", () => {
    expect(normalizeMarkStyle("quiet")).toBe("quiet");
    expect(normalizeMarkStyle("always")).toBe("always");
  });

  it("reads the old DEFAULT as the new default, and an old CHOICE as always-marked", () => {
    expect(normalizeMarkStyle("both")).toBe("quiet");
    expect(normalizeMarkStyle("underline")).toBe("always");
    expect(normalizeMarkStyle("tint")).toBe("always");
  });

  it("reads nothing, and anything it does not know, as the default", () => {
    expect(normalizeMarkStyle(undefined)).toBe("quiet");
    expect(normalizeMarkStyle(null)).toBe("quiet");
    expect(normalizeMarkStyle("loud" as never)).toBe("quiet");
  });
});
