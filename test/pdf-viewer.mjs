// Real upstream viewer, offline bytes, and source mapping under find/recycling.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {launchExtension} from "./harness.mjs";
import {TEST_PDF, LOCKED_PDF, PDF_PASSWORD, TALL_PDF} from "./pdf-fixture.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(ROOT, "test-results/pdf-viewer"); mkdirSync(artifacts, {recursive:true});
const {context, extId, fixture} = await launchExtension({extDir:join(ROOT,"output/chrome-mv3")});
const page = await context.newPage();
const failures = [], external = [];
page.on("pageerror", (error) => failures.push(error.message));
page.on("request", (request) => { if (/^https?:/.test(request.url())) external.push(request.url()); });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const input = (name, buffer) => ({name, mimeType:"application/pdf", buffer});
const ready = () => page.waitForFunction(() => !!window.PDFViewerApplication?.pdfDocument && document.querySelectorAll("#viewer .textLayer span").length > 5, null, {timeout:20000});
try {
  await page.addInitScript(() => { window.print = () => { window.__printSnapshot = [...document.querySelectorAll("#printContainer img")].map((image) => ({width:image.naturalWidth,height:image.naturalHeight})); }; });
  await context.setOffline(true);
  await page.goto(`chrome-extension://${extId}/reader.html?file=https://must-not-load.invalid/private.pdf`);
  await page.locator("#drop:not([hidden])").waitFor();
  assert.equal(new URL(page.url()).searchParams.has("file"), false);
  await page.locator("#file").setInputFiles(input("offline.pdf",TEST_PDF));
  await ready();
  const features = await page.evaluate(() => {
    const app=window.PDFViewerApplication, options=window.PDFViewerApplicationOptions;
    return {pages:app.pdfDocument.numPages, find:!!app.findController, outline:!!app.pdfOutlineViewer,
      thumbs:!!app.pdfThumbnailViewer || !!app.viewsManager, print:app.supportsPrinting,
      scripting:options.get("enableScripting"), url:options.get("defaultUrl"), editor:options.get("annotationEditorMode")};
  });
  assert.equal(features.pages,2); assert.equal(features.find,true); assert.equal(features.outline,true);
  assert.equal(features.thumbs,true); assert.equal(features.print,true); assert.equal(features.scripting,false);
  assert.equal(features.url,""); assert.equal(features.editor,-1);
  const toolbar=await page.evaluate(()=>["anagramAnalyze","printButton","downloadButton","secondaryToolbarToggleButton"].map(id=>{
    const r=document.getElementById(id).getBoundingClientRect();return {id,visible:r.width>0 && r.height>0 && r.left>=0 && r.right<=innerWidth};
  }));
  assert.ok(toolbar.every(button=>button.visible),`Toolbar controls stay inside viewport: ${JSON.stringify(toolbar)}`);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const bytes = await page.evaluate(async () => [...await window.PDFViewerApplication.pdfDocument.getData()]);
  assert.equal(digest(Buffer.from(bytes)),digest(TEST_PDF),"Rendering/analysis never rewrites source PDF bytes");
  await page.waitForFunction(() => [...document.querySelectorAll('.anagramPdfChips [data-anagram="host"]')].some((el)=>el.shadowRoot?.querySelector(".pill")), null, {timeout:15000}).catch(async () => {
    await page.screenshot({path:join(artifacts,"missing-chips.png")});
    throw new Error(`No Anagram chips: ${await page.locator("#notice").textContent()}; ${JSON.stringify(failures)}`);
  });
  await page.locator("#anagramAnalyze").click();
  await page.locator("#anagram-fab .pscope").waitFor();
  assert.match(await page.locator("#analysisScope").textContent(),/2/);
  assert.match(await page.locator("#anagram-fab .pscope").textContent(),/not a complete document assessment/);
  await page.keyboard.press("Escape");
  await page.screenshot({path:join(artifacts,"reading.png")});
  await page.locator("#viewFindButton").click();
  await page.locator("#findInput").fill("paragraph");
  await page.locator('label[for="findHighlightAll"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".textLayer .highlight").length > 0);
  await page.waitForFunction(() => [...document.querySelectorAll('.anagramPdfChips [data-anagram="host"]')].some((el)=>el.shadowRoot?.querySelector(".pill")));
  await page.locator(".anagramPdfChips .pill").first().hover();
  await page.locator("#scaleSelect").selectOption("1.5");
  await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.currentScale === 1.5);
  await page.locator("#secondaryToolbarToggleButton").click();
  await page.locator("#pageRotateCw").click();
  await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.pagesRotation === 90);
  const downloadPromise=page.waitForEvent("download");
  await page.locator("#downloadButton").click();
  const download=await downloadPromise;
  await download.saveAs(join(artifacts,"downloaded.pdf"));
  assert.equal(digest(readFileSync(join(artifacts,"downloaded.pdf"))),digest(TEST_PDF));
  await page.locator("#printButton").click();
  await page.waitForFunction(()=>window.__printSnapshot?.length===2);
  assert.ok(await page.evaluate(()=>window.__printSnapshot.every(image=>image.width>0 && image.height>0)),"Print pipeline renders all pages before the native print call");
  assert.equal(await page.locator("#viewsManagerAddFilePicker").isVisible(),false);
  await page.locator("#viewsManagerToggleButton").click();
  await page.screenshot({path:join(artifacts,"full-viewer.png")});

  // Upstream password dialog, including a refused password, remains functional offline.
  await page.locator("#file").setInputFiles(input("locked.pdf",LOCKED_PDF));
  await page.locator("#passwordDialog[open]").waitFor();
  await page.locator("#password").fill("wrong"); await page.locator("#passwordSubmit").click();
  await page.waitForFunction(() => document.querySelector("#passwordDialog")?.open && /invalid/i.test(document.querySelector("#passwordText")?.textContent ?? ""));
  await page.locator("#password").fill(PDF_PASSWORD); await page.locator("#passwordSubmit").click();
  await ready(); assert.equal(await page.locator("#passwordDialog").evaluate((el)=>el.open),false);

  // A new choice while a password is pending supersedes the old loading task/dialog.
  await page.locator("#file").setInputFiles(input("pending-password.pdf",LOCKED_PDF));
  await page.locator("#passwordDialog[open]").waitFor();
  await page.locator("#file").setInputFiles(input("replacement.pdf",TEST_PDF)); await ready();
  assert.equal(await page.locator("#passwordDialog").evaluate((el)=>el.open),false);
  assert.equal(await page.evaluate(()=>PDFViewerApplication.pdfDocument.numPages),2);

  // Visible-page extraction is bounded; navigating/revisiting must rebuild recycled layers.
  await page.locator("#file").setInputFiles(input("long.pdf",TALL_PDF)); await ready();
  const start=await page.evaluate(()=>({pages:window.PDFViewerApplication.pdfDocument.numPages, layers:document.querySelectorAll("#viewer .textLayer").length}));
  assert.equal(start.pages,30); assert.ok(start.layers < 10,"Opening a long PDF does not build every text layer");
  await page.locator("#pageNumber").fill("30"); await page.locator("#pageNumber").press("Enter");
  await page.waitForFunction(()=>window.PDFViewerApplication.page===30 && !!document.querySelector('.page[data-page-number="30"] .textLayer span'));
  await page.locator("#pageNumber").fill("1"); await page.locator("#pageNumber").press("Enter");
  await page.waitForFunction(()=>window.PDFViewerApplication.page===1 && !!document.querySelector('.page[data-page-number="1"] .textLayer span'));

  // A stopped engine must not block the full viewer or its local file picker.
  fixture.close();
  await page.locator("#file").setInputFiles(input("without-engine.pdf",TEST_PDF)); await ready();
  assert.equal(await page.evaluate(()=>window.PDFViewerApplication.pdfDocument.numPages),2);
  const rejected=await page.evaluate(async()=>{try{await window.PDFViewerApplication.open({url:"https://must-not-load.invalid/b.pdf"});return false;}catch{return true;}});
  assert.equal(rejected,true); assert.deepEqual(external,[],"All viewer/parser/font/locale requests stay packaged while offline");
  await page.setViewportSize({width:400,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,"Reader chrome stays within a narrow window");
  await page.emulateMedia({colorScheme:"dark"});
  await page.evaluate(readFileSync(join(ROOT,"node_modules/axe-core/axe.min.js"),"utf8"));
  const violations=await page.evaluate(async()=>(await axe.run({include:[["#anagramAnalyze"],["#analysisScope"]]},{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})));
  assert.deepEqual(violations,[],"Anagram reader controls have no focused WCAG AA violations");
  await page.screenshot({path:join(artifacts,"narrow-dark.png")});
  assert.deepEqual(failures,[]);

  // Source offsets survive nested search markup and page replacement (real DOM/Range).
  const {outputFiles} = await build({entryPoints:[join(ROOT,"lib/pdf/units.ts")],bundle:true,write:false,format:"iife",globalName:"PdfUnits"});
  const mapping=await context.newPage(); await mapping.addScriptTag({content:outputFiles[0].text});
  const result=await mapping.evaluate(()=>{
    const text="The paragraph carries enough words to be analyzed. ".repeat(10);
    const layer=document.createElement("div"), span=document.createElement("span");span.textContent=text;layer.append(span);document.body.append(layer);
    const source=PdfUnits.createPdfUnitSource();source.setPage(1,{layer,spans:[span]});
    source.setBlocks([{kind:"paragraph",page:1,text,runs:[{page:1,item:0,at:0,length:text.length,from:0}]}]);
    const [first]=source.collect(()=>"take",false);
    const nested=document.createElement("span");nested.className="highlight";nested.textContent=text.slice(4,22);
    span.replaceChildren(document.createTextNode(text.slice(0,4)),nested,document.createTextNode(text.slice(22)));
    const rangeText=source.ranges(first,[{start:2,end:35}])[0].map((range)=>range.toString()).join("");
    const [second]=source.collect(()=>"take",false);
    const nodesFresh=second.parts[0].nodes.every(node=>node.isConnected);
    layer.remove();source.removePage(1);
    const missing=source.collect(()=>"take",false).length;
    document.body.append(layer);source.setPage(1,{layer,spans:[span]});
    const [third]=source.collect(()=>"take",false);
    return {rangeText,expected:text.slice(2,35),nodesFresh,missing,rebound:third.parts[0].nodes.every(node=>node.isConnected)};
  });
  assert.equal(result.rangeText,result.expected);assert.equal(result.nodesFresh,true);assert.equal(result.missing,0);assert.equal(result.rebound,true);
  await mapping.close();
  console.log("PASS: upstream full viewer offline/picker/password/search/zoom/rotation/thumbnail/print/download/source bytes/recycling/engine-down + nested mapping");
} catch (error) {
  await page.screenshot({path:join(artifacts,"failure.png")}).catch(()=>{});
  console.error({failures,external,notice:await page.locator("#notice").textContent().catch(()=>null)});
  throw error;
} finally {await context.close();}
