// Focused macOS Firefox full-viewer check; no installed profile/component is used.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {launchFirefox} from "./firefox-harness.mjs";
import {TEST_PDF, LOCKED_PDF, PDF_PASSWORD} from "./pdf-fixture.mjs";
const ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
const artifacts=join(ROOT,"test-results/pdf-viewer");mkdirSync(artifacts,{recursive:true});

const {browser,extUrl,fixture,firefox}=await launchFirefox({extDir:join(ROOT,"output/firefox-mv2")});
const page=await browser.newPage();const external=[],errors=[];
page.on("request",(r)=>{if(/^https?:/.test(r.url()))external.push(r.url());});
page.on("pageerror",(e)=>errors.push(e.message));
// Firefox BiDi rejects privileged input.setFiles/performActions. Exercise the real
// input change handler with a File/DataTransfer; OS picker interaction is not automated.
const choose=(name,bytes)=>page.evaluate((name,data)=>{
  const files=new DataTransfer();files.items.add(new File([Uint8Array.from(data)],name,{type:"application/pdf"}));
  const input=document.getElementById("file");input.files=files.files;input.dispatchEvent(new Event("change",{bubbles:true}));
},name,[...bytes]);
const click=(id)=>page.evaluate(id=>document.getElementById(id).click(),id);
const fill=(id,value)=>page.evaluate((id,value)=>{const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event("input",{bubbles:true}));},id,value);
const ready=()=>page.waitForFunction(()=>!!window.PDFViewerApplication?.pdfDocument && document.querySelectorAll("#viewer .textLayer span").length>5,{timeout:20000});
try{
  await page.setOfflineMode(true);
  void page.goto(extUrl("reader.html?file=https://must-not-load.invalid/secret.pdf"),{timeout:1000}).catch(()=>{});
  await page.waitForSelector("#drop:not([hidden])");
  await choose("offline.pdf",TEST_PDF);await ready();
  const features=await page.evaluate(()=>({pages:PDFViewerApplication.pdfDocument.numPages,
    find:!!PDFViewerApplication.findController,outline:!!PDFViewerApplication.pdfOutlineViewer,
    thumbnails:!!PDFViewerApplication.viewsManager,print:PDFViewerApplication.supportsPrinting,
    scripting:PDFViewerApplicationOptions.get("enableScripting"),url:PDFViewerApplicationOptions.get("defaultUrl")}));
  assert.deepEqual(features,{pages:2,find:true,outline:true,thumbnails:true,print:true,scripting:false,url:""});
  await page.waitForFunction(()=>[...document.querySelectorAll('.anagramPdfChips [data-anagram="host"]')].some(el=>el.shadowRoot?.querySelector(".pill")),{timeout:15000});
  const bytes=await page.evaluate(async()=>[...await PDFViewerApplication.pdfDocument.getData()]);
  const hash=(bytes)=>createHash("sha256").update(bytes).digest("hex");assert.equal(hash(Buffer.from(bytes)),hash(TEST_PDF));
  await click("viewFindButton");await fill("findInput","paragraph");await click("findHighlightAll");
  await page.waitForFunction(()=>document.querySelectorAll(".textLayer .highlight").length>0);
  await page.waitForFunction(()=>[...document.querySelectorAll('.anagramPdfChips [data-anagram="host"]')].some(el=>el.shadowRoot?.querySelector(".pill")),{timeout:15000});
  await page.evaluate(()=>{const select=document.getElementById("scaleSelect");select.value="1.5";select.dispatchEvent(new Event("change",{bubbles:true}));});
  await page.waitForFunction(()=>PDFViewerApplication.pdfViewer.currentScale===1.5);
  await click("secondaryToolbarToggleButton");await click("pageRotateCw");
  await page.waitForFunction(()=>PDFViewerApplication.pdfViewer.pagesRotation===90);
  await page.screenshot({path:join(artifacts,"firefox-viewer.png")}).catch(()=>{});
  await choose("password.pdf",LOCKED_PDF);await page.waitForSelector("#passwordDialog[open]");
  await fill("password",PDF_PASSWORD);await click("passwordSubmit");await ready();
  fixture.close();await choose("offline.pdf",TEST_PDF);await ready();
  assert.equal(await page.evaluate(()=>PDFViewerApplication.pdfDocument.numPages),2);
  assert.equal(await page.evaluate(async()=>{try{await PDFViewerApplication.open({url:"https://must-not-load.invalid/x.pdf"});return false;}catch{return true;}}),true);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log(`PASS Firefox ${firefox.version}: offline full viewer/File input handler/controllers/search/zoom/rotation/password/engine-down/source hash/no external requests`);
}catch(error){await page.screenshot({path:join(artifacts,"firefox-failure.png")}).catch(()=>{});console.error({errors,external,notice:await page.$eval("#notice",el=>el.textContent).catch(()=>null)});throw error;}
finally{await browser.close();}
