// Local extraction measurements, independent of model/runtime speed and network sites.
// See test/README.md. Deliberately no timing thresholds or machine-dependent pass/fail.
import { buildSync } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { cpus, platform, arch } from "node:os";
import { launchPlain } from "./harness.mjs";
import { docsReadingHtml } from "./fixtures/docs-reading.mjs";
import { PDF_PARAS, PDF_HEAD, PDF_HEADING, pdfColumn } from "./pdf-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..");
const options = { runs: 15, warmup: 2 };
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index].replace(/^--/, ""), value = Number(process.argv[++index]);
  if (!Object.hasOwn(options, key) || !Number.isInteger(value) || value < (key === "runs" ? 1 : 0) || value > 200)
    throw new Error("Usage: node test/extraction-benchmark.mjs [--runs 15] [--warmup 2] (0–200 warmups, 1–200 measured runs)");
  options[key] = value;
}
const bundle = buildSync({entryPoints:[join(HERE,"unit-entry.ts")],bundle:true,format:"iife",globalName:"PW",write:false,logLevel:"error"}).outputFiles[0].text;
const readability = ["Readability.js", "Readability-readerable.js"].map((name) =>
  readFileSync(join(ROOT, "node_modules/@mozilla/readability", name), "utf8"));
const fixture = (name) => readFileSync(join(HERE,"fixtures",name),"utf8");
const article = fixture("news-article.html"), thread = fixture("thread-100.html");
const cases = [
  {name:"article",source:"test/fixtures/news-article.html",html:article},
  {name:"x-feed",source:"test/fixtures/x-timeline.html",html:fixture("x-timeline.html")},
  {name:"linkedin-feed",source:"test/fixtures/linkedin-feed.html",html:fixture("linkedin-feed.html")},
  {name:"docs-reading",source:"test/fixtures/docs-reading.mjs + PDF_PARAS prose",html:docsReadingHtml(PDF_PARAS.map((lines)=>lines.join(" ")))},
  {name:"thread-100",source:"test/fixtures/thread-100.html",html:thread},
  {name:"large-thread-1000",source:"thread-100.html, ten copies of its 100 comments",html:thread,transform:"large"},
  {name:"deep-article-128",source:"news-article.html inside 128 nested divs",html:article,transform:"deep"},
];
// Same placed text as TEST_PDF, represented at the reflow input seam. This measures
// structured reconstruction, not PDF byte decoding, font loading, rasterization or OCR.
const placed = [
  [{x:72,y:742,size:9,text:PDF_HEAD},{x:300,y:50,size:10,text:"1"},{x:72,y:700,size:16,text:PDF_HEADING},
    ...pdfColumn(PDF_PARAS[0],670),...pdfColumn(PDF_PARAS[1],670-PDF_PARAS[0].length*14)],
  [{x:72,y:742,size:9,text:PDF_HEAD},{x:300,y:50,size:10,text:"2"},
    ...pdfColumn(PDF_PARAS[2],700),...pdfColumn(PDF_PARAS[3],700-PDF_PARAS[2].length*14-14)],
];
const pdfPages = placed.map((rows,index)=>({page:index+1,width:612,height:792,items:rows.map((row)=>({
  str:row.text,x:row.x,y:792-row.y,width:row.text.length*5.1*(row.size/11),height:row.size,fontName:row.size===16?"heading":"body",
}))}));
const quantiles = (values) => {
  const sorted = [...values].sort((a,b)=>a-b);
  const q = (fraction) => sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)];
  return {p50:q(.5),p90:q(.9),samples:values};
};
let revision = null, dirty = null;
try {
  revision = execFileSync("git",["rev-parse","HEAD"],{cwd:ROOT,encoding:"utf8"}).trim();
  dirty = !!execFileSync("git",["status","--porcelain"],{cwd:ROOT,encoding:"utf8"}).trim();
} catch { /* source archive */ }
const report = {schema_version:1,created_at:new Date().toISOString(),revision,dirty,bundle_sha256:createHash("sha256").update(bundle).digest("hex"),environment:{node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model},
  options,network:"blocked",timings:"milliseconds; warmups omitted; document creation and source-range verification excluded",cases:[]};
const browser = await launchPlain({headless:true});
const context = await browser.newContext({viewport:{width:1280,height:850},offline:true,serviceWorkers:"block"});
let blockedRequests = 0;
await context.route("**/*",(route)=>{blockedRequests++;return route.abort();});
try {
  report.environment.browser = browser.version();
  for (const item of [...cases,{name:"structured-pdf",source:"TEST_PDF placement via PDF_PARAS/pdfColumn",html:"<!doctype html><html><body></body></html>",pdf:true}]) {
    const page = await context.newPage();
    try {
      await page.setContent(item.html,{waitUntil:"load"});
      await page.addScriptTag({content:bundle});
      for (const content of readability) await page.addScriptTag({content});
      const measured = await page.evaluate(({runs,warmup,transform,pdf,pages})=>{
        const R = {Readability:window.Readability,isProbablyReaderable:window.isProbablyReaderable};
        PW.useReadability(R);
        if (transform === "large") {
          const root = document.getElementById("thread"), originals = [...root.children];
          for(let copy=1;copy<10;copy++) for(const post of originals) root.appendChild(post.cloneNode(true));
        } else if (transform === "deep") {
          const nodes = [...document.body.childNodes]; let root = document.body;
          for(let depth=0;depth<128;depth++) root = root.appendChild(document.createElement("div"));
          root.append(...nodes);
        }
        const describeUnits = (units,locate) => {
          let windows=0,mappedWindows=0,ranges=0,sourceNodes=new Set();
          for(const unit of units) {
            const spans=PW.planWindows(unit.text), mapped=locate(unit,spans); windows+=spans.length;
            for(const group of mapped??[]) {
              if(group.length && group.every((range)=>range.startContainer.isConnected && range.endContainer.isConnected && !range.collapsed)) mappedWindows++;
              ranges+=group.length;
            }
            for(const part of unit.parts) for(const node of part.nodes) sourceNodes.add(node);
          }
          return {units:units.length,words:units.reduce((sum,unit)=>sum+unit.wordCount,0),unit_chars:units.reduce((sum,unit)=>sum+unit.text.length,0),
            source_nodes:sourceNodes.size,source_ranges:ranges,planned_windows:windows,mapped_windows:mappedWindows,
            source_window_coverage:windows?mappedWindows/windows:null};
        };
        const samples=[], counts=[];
        if(pdf) {
          const layers = pages.map((page)=>{
            const layer=document.body.appendChild(document.createElement("div"));
            const spans=page.items.map((item)=>{const span=layer.appendChild(document.createElement("span"));span.textContent=item.str;return span;});
            return {page:page.page,layer,spans};
          });
          for(let iteration=-warmup;iteration<runs;iteration++) {
            const t0=performance.now(), blocks=PW.reflowPdf(pages), t1=performance.now();
            const source=PW.createPdfUnitSource();
            for(const layer of layers) source.setPage(layer.page,layer);
            source.setBlocks(blocks);
            const units=source.collect(()=>"take"), t2=performance.now();
            if(iteration<0) continue;
            samples.push({reflow:t1-t0,collect:t2-t1});
            counts.push({...describeUnits(units,(unit,spans)=>source.ranges(unit,spans)),reflow_blocks:blocks.length,
              reflow_chars:blocks.reduce((sum,block)=>sum+block.text.length,0),
              source_run_chars:blocks.reduce((sum,block)=>sum+block.runs.reduce((n,run)=>n+run.length,0),0)});
          }
          return {layer:"structured-pdf",samples,counts,input_pages:pages.length,input_items:pages.reduce((sum,page)=>sum+page.items.length,0),
            excludes:["PDF byte parsing","font decoding","rasterization","OCR","inference"]};
        }
        let region;
        for(let iteration=-warmup;iteration<runs;iteration++) {
          const t0=performance.now(), all=PW.collectUnits(document.body), t1=performance.now();
          region=PW.findMainContent(document); const t2=performance.now();
          const main=PW.collectUnits(region??document.body), t3=performance.now();
          if(iteration<0) continue;
          samples.push({collect:t1-t0,find_main:t2-t1,collect_main:t3-t2});
          const locate=(unit,spans)=>PW.locateSpans(unit.parts,unit.text,spans);
          counts.push({whole_page:describeUnits(all,locate),main:describeUnits(main,locate)});
        }
        return {layer:"live-dom",samples,counts,elements:document.querySelectorAll("*").length,
          main_region:region?{tag:region.tagName,id:region.id,class:region.className}:null,
          main_fallback_to_body:!region};
      },{...options,transform:item.transform,pdf:!!item.pdf,pages:item.pdf?pdfPages:null});
      const fields=Object.keys(measured.samples[0]);
      const timings=Object.fromEntries(fields.map((field)=>[`${field}_ms`,quantiles(measured.samples.map((sample)=>sample[field]))]));
      const counts=measured.counts[0], countsStable=measured.counts.every((value)=>JSON.stringify(value)===JSON.stringify(counts));
      const {samples:_,counts:__,...meta}=measured;
      report.cases.push({name:item.name,source:item.source,input_sha256:createHash("sha256").update(item.pdf?JSON.stringify(pdfPages):item.html+(item.transform??"")).digest("hex"),
        ...meta,timings,counts,counts_stable:countsStable});
      console.log(`${item.name}: collect p50=${timings.collect_ms.p50.toFixed(2)}ms p90=${timings.collect_ms.p90.toFixed(2)}ms`);
    } finally { await page.close(); }
  }
} finally { try { await context.close(); } finally { await browser.close(); } }
report.blocked_requests=blockedRequests;
const out=join(ROOT,"test-results/extraction");mkdirSync(out,{recursive:true});
const path=join(out,`extraction-${report.created_at.replace(/[:.]/g,"-")}.json`);
writeFileSync(path,JSON.stringify(report,null,2)+"\n");console.log(path);
