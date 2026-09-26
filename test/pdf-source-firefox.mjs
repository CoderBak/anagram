// Real Firefox online PDF routing; only a throwaway extension/profile and loopback server.
import assert from "node:assert/strict";
import http from "node:http";
import {cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {launchFirefox, openExtensionPage, hrefOf, until} from "./firefox-harness.mjs";
import {TEST_PDF} from "./pdf-fixture.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = mkdtempSync(join(tmpdir(), "anagram-firefox-pdf-source-"));
const extension = join(staging, "extension");
cpSync(join(root, "output/firefox-mv2"), extension, {recursive:true});
const manifestPath = join(extension, "manifest.json"), manifest = JSON.parse(readFileSync(manifestPath,"utf8"));
// Test-only exact loopback grant: product permissions remain optional.
manifest.permissions.push("http://localhost/*");
writeFileSync(manifestPath, JSON.stringify(manifest));
const requests = [];
const server = http.createServer((req,res) => {
  requests.push({url:req.url, method:req.method, cookie:req.headers.cookie ?? ""});
  if (req.url !== "/document") { res.writeHead(404); res.end(); return; } // the tab's favicon
  // The cookie is set once, by the page's own visit: Firefox refuses, and logs as a page
  // error, a Lax cookie set in the response to a cross-site read like the extension's.
  const set = req.headers.cookie?.includes("anagram_pdf_source") ? {} : {"set-cookie":"anagram_pdf_source=fixture; SameSite=Lax"};
  res.writeHead(200,{"content-type":"application/pdf", "cache-control":"no-store", "content-length":TEST_PDF.length, ...set});res.end(TEST_PDF);
});
await new Promise((resolve) => server.listen(0,"127.0.0.1",resolve));
const source = `http://localhost:${server.address().port}/document`;
let instance;
try {
  instance = await launchFirefox({extDir:extension});
  const {browser, extUrl} = instance;
  const driver = await openExtensionPage(browser,extUrl("popup.html"));
  await driver.evaluate(async () => {
    await browser.storage.local.set({autoOpenPdfs:false});
    const bg=await browser.runtime.getBackgroundPage();bg.__pdfSourceTrace=[];
    bg.browser.tabs.onUpdated.addListener((id,change)=>bg.__pdfSourceTrace.push({type:"tab",id,change}));
    bg.browser.webNavigation.onBeforeNavigate.addListener((value)=>bg.__pdfSourceTrace.push({type:"nav",value}));
    bg.browser.runtime.onConnect.addListener((port)=>{
      if(!port.name.startsWith("anagram-pdf"))return;
      bg.__pdfSourceTrace.push({type:"port",name:port.name,sender:port.sender});
      port.onMessage.addListener((value)=>bg.__pdfSourceTrace.push({type:"message",name:port.name,value}));
      port.onDisconnect.addListener(()=>bg.__pdfSourceTrace.push({type:"disconnect",name:port.name}));
    });
  });
  const page = await browser.newPage(); const errors = [];
  page.on("pageerror",(error) => errors.push(error.message));
  await page.goto(source,{waitUntil:"domcontentloaded",timeout:10000}).catch(() => {});
  const tabId = await driver.evaluate(async (url) => (await browser.tabs.query({})).find((tab)=>tab.url===url)?.id, source);
  assert.ok(tabId!==undefined,"Native PDF tab must be observable under its granted source");
  const status = await driver.evaluate((id) => browser.runtime.sendMessage({action:"GET_PDF_STATUS",tabId:id}), tabId);
  assert.deepEqual(status,{pdf:true,source,local:false,authorized:true},"MIME recognizes suffixless native Firefox PDFs");
  assert.equal(await hrefOf(page),source,"Auto off preserves native viewer");
  const opened = await driver.evaluate(([id,url]) => browser.runtime.sendMessage({action:"openPdfReader",tabId:id,url}),[tabId,source]);
  assert.equal(opened.ok,true,JSON.stringify(opened));
  // Firefox's own viewer has a PDFViewerApplication too: the reader's address first.
  const inReader = (prefix) => location.href.startsWith(prefix) && !!window.PDFViewerApplication?.pdfDocument;
  await until(page, inReader, {timeout:20000, arg:extUrl("reader.html")}).catch(async(error)=>{
    console.error(JSON.stringify({trace:await driver.evaluate(async()=>(await browser.runtime.getBackgroundPage()).__pdfSourceTrace),
      state:await page.evaluate(()=>({url:location.href,notice:document.getElementById("notice")?.textContent,frames:[...document.querySelectorAll("iframe")].map((frame)=>frame.src)})),errors,requests},null,2));throw error;
  });
  const raw = await page.evaluate(async () => [...await window.PDFViewerApplication.pdfDocument.getData()]);
  assert.equal(createHash("sha256").update(Buffer.from(raw)).digest("hex"),createHash("sha256").update(TEST_PDF).digest("hex"));
  assert.ok(requests.filter((r) => r.url === "/document").length >= 2,"No-store fixture actually exercises the extension loader GET");
  assert.ok(requests.slice(1).some((r) => r.cookie.includes("anagram_pdf_source=fixture")),"Authorized source read retains its cookie");
  await driver.evaluate(() => browser.storage.local.set({autoOpenPdfs:true}));
  await page.evaluate(()=>document.getElementById("original").click()); await until(page, (url) => location.href === url, {arg:source});
  await new Promise((resolve) => setTimeout(resolve,600)); assert.equal(await hrefOf(page),source,"Open original bypass lasts for the whole navigation");
  await page.reload({waitUntil:"domcontentloaded",timeout:2500}).catch(() => {});
  await until(page, inReader, {timeout:20000, arg:extUrl("reader.html")});
  assert.ok((await hrefOf(page)).startsWith(extUrl("reader.html")),"Reload routes after the one-navigation pass is spent");
  const before = requests.length;
  const forged = await browser.newPage();
  await forged.goto(`${extUrl("reader.html")}?src=${encodeURIComponent(source)}&ticket=s-${"a".repeat(32)}`,{waitUntil:"domcontentloaded",timeout:2500}).catch(()=>{});
  await until(forged, () => !!document.querySelector("#drop:not([hidden])"));
  await new Promise((resolve) => setTimeout(resolve,500));
  assert.equal(requests.length,before,"Forged ticket does not read a source");
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({browser:instance.firefox.version,checks:["suffixless MIME", "auto off", "exact PDF bytes", "credentialed GET", "original bypass", "auto reload", "forged ticket refused"], requests:requests.map((r) => ({path:r.url,method:r.method,cookie:r.cookie.includes("anagram_pdf_source=fixture")}))},null,2));
} finally {
  await instance?.browser.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  rmSync(staging,{recursive:true,force:true});
}
