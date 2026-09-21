// test/pdf-codecs-check.mjs — can the PDF view really decode a JPEG2000 or JBIG2 image?
//
// The packaged upstream viewer uses PDF.js's WebAssembly image decoders. Exercise
// both in the shipping extension so its actual CSP and local assets apply.
// Run `npm run build` first; this script does not replace shared build output.
//
// The two documents are built from codestreams generated on 2026-09-20 with the tools on
// the machine — Pillow 11.1.0 / OpenJPEG 2.5.3 for the JPEG2000 tile, jbig2enc for the
// JBIG2 one — and carried below as base64 rather than as binary files in the tree, so
// that what is in them can be read. Each is a shape that is obvious when it draws and
// just as obvious when it does not: a red tile with a white cross, and a black frame
// around a black square. A decoder that fails leaves the page white, which is exactly
// what this measures.
//
//   node test/pdf-codecs-check.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension } from "./harness.mjs";

// Use the existing shipping package; this test needs no website grants or test build.
const EXT = join(dirname(fileURLToPath(import.meta.url)), "../output/chrome-mv3");

const results = [];
const record = (name, ok, note = "") =>
  results.push({ name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note: String(note) });

// ---- the two codestreams ------------------------------------------------------------------

/** A 64×64 RGB tile, red with a white cross, as a raw JPEG 2000 codestream. */
const JPX = Buffer.from(
  "/0//UQAvAAAAAABAAAAAQAAAAAAAAAAAAAAAQAAAAEAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEABQQEAAH/XAATQEBI" +
    "SFBISFBISFBISFBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjP/kAAKAAAAAARkAAH/k8+0FAHP" +
    "a/HB34AwB/jIgOo/34AwB/jIgOo/w+oEh9QLB9QIDjP17AxTdwjPEFDcx9+YNfmDR+AMDjez8iFLDFc0sExnEAKrLtjf35g1" +
    "+YNH4AwON7PyIUsMVzSwTGcQAqsu2N/B84uD5xUB8gUXBS3rXP6Gt+eGIwuIkYlBs8Z47TUVtCPlU8/AQn4CEPtCgBcFLete" +
    "SMr0OJtaumo6n58LiJGJSNxYQmGCJFODHsofFbQj1MjrzVcBn8/AQn4CEPtCgBcFLeteSMr0OJtaumo6n58LiJGJSNxYQmGC" +
    "JFODHsofFbQj1MjrzVcBn8D5CUD5CUAdGCIQf/ryZmCIDz1VW91A4JzTKwN4MhjKggYQfEXkkIJW5DXzfySs7QcuD8faPR9o" +
    "7A+cWCaN2SPERiCnR8FzLoHw3Zld9TbPU2HDXCNHHvtbzztZhjxnnrT0CL77lDyOozAP7uwn91D5rukx1dzfKTXIXe4bSpUG" +
    "uF/H2j0faOwPnFgmjdkjxEYgp0fBcy6B8N2ZXfU2z1Nhw1wjRx77W887WYY8Z5609Ai++5Q8jqMwD+7sJ/dQ+a7pMdXc3yk1" +
    "yF3uG0qVBrhfwfOkg+dFAfIQMM6A3d2S+mcpaEJBJ6AFFPGkmwhIBKYYaiqWXL1vWnoUr+zfZY78tevBlxw6p+zvRrzqlsDm" +
    "6KzEA55Qa8MyAjN2DyvCP4IbkK9aGQ2BAoBCNgdZzH/PwOJ+BzD7RUCCHJq7iGwc1y9AoLqCg+y8+rqhfToY9+NC52EaL106" +
    "Hdqe7sm8/OH864tc0WF9LQ9aANRicAhuJ4IcsOULKVUC4ETzp3gfRRXSC5S2N8vmaxLEDOa/emj2iGkvTxqik+/dzk3NAAuD" +
    "q5lThLiLKSwdS4IbkK9aGSorIB/4iSXQ1UzSKN6Rpc/A4n4HMPtFQIIcmruIbBzXL0CguoKD7Lz6uqF9Ohj340LnYRovXTod" +
    "2p7uybz84fzri1zRYX0tD1oA1GJwCG4nghyw5QspVQLgRPOneB9FFdILlLY3y+ZrEsQM5r96aPaIaS9PGqKT793OTc0AC4Or" +
    "mVOEuIspLB1LghuQr1oZKisgH/iJJdDVTNIo3pGlwfOlg+c/AfIKVLYJRFdQQ+2AQOoM1yZiI3ZKAHZYwsBBSRsNeywTN83j" +
    "RsFtusQLIOiH9WW/LsvjOXQmLVx5WTK57sQAYiJbGNXIMI/HglQvpKizJbY/x9pTH2ksH1BYVLYJRFdQSvfMUlegIMIV6JsZ" +
    "9v4DCLIRjV1Y2foB9ANyRD2KXnYW3X/ECyDof3V9fPLkHGmoR19eu/CD6AXRjpvHcFKvGaVeX7chgL69x4JUL6SouACb6H/H" +
    "2lMfaSwfUFhUtglEV1BK98xSV6AgwhXomxn2/gMIshGNXVjZ+gH0A3JEPYpedhbdf8QLIOh/dX188uQcaahHX1678IPoBdGO" +
    "m8dwUq8ZpV5ftyGAvr3HglQvpKi4AJvof//Z",
  "base64",
);

/** A 64×64 bilevel image — a black frame around a black square — as an embedded JBIG2
 *  generic region, the form `jbig2enc --pdf` writes for a PDF stream (no globals). */
const JBIG2 = Buffer.from(
  "AAAAADAAAQAAABMAAABAAAAAQAAAAAAAAAAAAQAAAAAAASYAAQAAAD0AAABAAAAAQAAAAAAAAAAAAAAD//3/Av7+/v9l8KAc" +
    "3VhwtNaB6TM4/3//f+/8fYLyf/9Y5Kuiwj8sr/+s",
  "base64",
);

/**
 * A one-page PDF whose whole page is one image, drawn through `filter`. The page box is
 * the image's own size in points, so "the image region" is the page and the check below
 * can simply ask how much of the canvas stopped being white.
 */
function imagePdf(filter, bytes, { colorSpace, bpc }) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add(null);
  const pageTree = add(null);
  const image = add(
    `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace ${colorSpace} ` +
      `/BitsPerComponent ${bpc} /Filter ${filter} /Length ${bytes.length} >>\nstream\n` +
      `${bytes.toString("latin1")}\nendstream`,
  );
  const stream = "q 256 0 0 256 0 0 cm /Im0 Do Q\n";
  const contents = add(
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
  );
  const page = add(
    `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 256 256] ` +
      `/Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${contents} 0 R >>`,
  );
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;

  let pdf = "%PDF-1.5\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const DOCUMENTS = {
  "/jpx.pdf": imagePdf("/JPXDecode", JPX, { colorSpace: "/DeviceRGB", bpc: 8 }),
  "/jbig2.pdf": imagePdf("/JBIG2Decode", JBIG2, { colorSpace: "/DeviceGray", bpc: 1 }),
};

// ---- what the manifest says -------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const policy = manifest.content_security_policy?.extension_pages ?? "";
const declaresWasm = /(^|[\s;])script-src[^;]*'wasm-unsafe-eval'/.test(policy);
record(
  "the built manifest lets its own pages compile the WebAssembly it ships",
  declaresWasm,
  policy || "(no content_security_policy in the manifest)",
);

// ---- the browser ---------------------------------------------------------------------------

const { context, extId } = await launchExtension({ extDir: EXT });
const READER = `chrome-extension://${extId}/reader.html`;

/**
 * Open one document in the reader and report what the canvas holds. Blank is the failure
 * this exists to catch, so the measure is the share of pixels that are NOT white — a page
 * whose image never decoded is white from corner to corner.
 */
async function draw(name) {
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  // Supply local File bytes so this tests packaged decoding rather than source loading.
  await page.goto(READER, { waitUntil: "load" });
  await page.waitForSelector("#drop:not([hidden])");
  await page.setInputFiles("#file", { name, mimeType: "application/pdf", buffer: DOCUMENTS[`/${name}`] });
  // The canvas is drawn when its page comes near the viewport, and the drawing itself is
  // a round trip to the pdf.js worker. Poll rather than guess at a delay.
  const ink = await page
    .waitForFunction(
      () => {
        const view = window.PDFViewerApplication?.pdfViewer.getPageView(0);
        const canvas = document.querySelector("#viewer .page canvas");
        // A white canvas exists before decoding finishes. Wait for upstream FINISHED.
        if (view?.renderingState !== 3 || !canvas || canvas.width === 0) return false;
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let dark = 0;
        let red = 0;
        for (let i = 0; i < data.length; i += 4) {
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
          if (r < 200 || g < 200 || b < 200) dark++;
          if (r > 150 && g < 120 && b < 120) red++;
        }
        const total = data.length / 4;
        return { share: dark / total, red: red / total, total };
      },
      null, { timeout: 20000, polling: 400 },
    )
    .then((h) => h.jsonValue())
    .catch(() => ({ share: 0, red: 0, total: 0 }));
  const csp = await page.evaluate(() => window.__csp ?? []).catch(() => []);
  await page.close();
  return { ink, problems, csp };
}

const jpx = await draw("jpx.pdf");
record(
  "a JPEG 2000 image (JPXDecode) really decodes — the page is not blank, and it is red",
  jpx.ink.share > 0.5 && jpx.ink.red > 0.4,
  JSON.stringify(jpx.ink),
);
record(
  "…and nothing was refused or thrown while it drew",
  jpx.csp.length === 0 && jpx.problems.length === 0,
  JSON.stringify([...jpx.csp, ...jpx.problems].slice(0, 3)),
);

const jbig2 = await draw("jbig2.pdf");
record(
  "a JBIG2 image (JBIG2Decode) really decodes — the page is not blank",
  jbig2.ink.share > 0.2,
  JSON.stringify(jbig2.ink),
);
record(
  "…and nothing was refused or thrown while it drew",
  jbig2.csp.length === 0 && jbig2.problems.length === 0,
  JSON.stringify([...jbig2.csp, ...jbig2.problems].slice(0, 3)),
);

await context.close();

// ---- summary ----------------------------------------------------------------------------

console.log("\n=== PDF IMAGE DECODERS ===");
for (const r of results)
  console.log(`${r.status.padEnd(4)}  ${r.name}${r.note && r.status !== "PASS" ? `  —  ${r.note}` : ""}`);
const fails = results.filter((r) => r.status === "FAIL");
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
console.log(fails.length === 0 ? "✅ PDF DECODERS GREEN" : "❌ PDF DECODER FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
