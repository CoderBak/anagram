// test/node/surfaces.test.ts — which addresses carry a reading surface (lib/surfaces/index.ts).
import { describe, expect, it } from "vitest";
import { surfaceFor } from "../../lib/surfaces";

const at = (url: string) => new URL(url);
const noViewer = { querySelector: () => null };

describe("surfaceFor", () => {
  it("reads Overleaf's PDF preview with the pdf.js surface, though its viewer comes after the page", () => {
    // The editor is an app: the preview's `.pdfViewer` is built once the project has loaded
    // and compiled, long after the content script looked for it.
    expect(surfaceFor(at("https://www.overleaf.com/project/64f0c0ffee0123456789abcd"), noViewer)).toBe("pdfjs");
    expect(surfaceFor(at("https://cn.overleaf.com/project/64f0c0ffee0123456789abcd"), noViewer)).toBe("pdfjs");
    // Overleaf's other pages are ordinary pages.
    expect(surfaceFor(at("https://www.overleaf.com/project"), noViewer)).toBeNull();
    expect(surfaceFor(at("https://www.overleaf.com/learn/latex/Bibliography_management"), noViewer)).toBeNull();
    expect(surfaceFor(at("https://overleaf.com.example.org/project/64f0c0ffee0123456789abcd"), noViewer)).toBeNull();
  });

  it("still finds a pdf.js viewer on any page that has one when the script starts", () => {
    expect(surfaceFor(at("https://example.org/viewer.html"), { querySelector: (s: string) => (s === ".pdfViewer" ? ({} as Element) : null) })).toBe("pdfjs");
    expect(surfaceFor(at("https://example.org/viewer.html"), noViewer)).toBeNull();
  });
});
