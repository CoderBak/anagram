// Shipping UI + isolated native stdio fixture; no network downloads or model loads.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, uiLanguage, uiLanguageOf } from "./harness.mjs";
import { createNativeFixture } from "./fake-native.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "output/chrome-mv3");
const artifacts = join(ROOT, "test-results/download-plan");
mkdirSync(artifacts, {recursive:true});
assert.equal(JSON.parse(readFileSync(join(EXT,"manifest.json"),"utf8")).host_permissions, undefined);

for (const language of ["en", "zh-CN"]) {
  const messages = JSON.parse(readFileSync(join(ROOT,"public/_locales",language === "en" ? "en" : "zh_CN","messages.json"),"utf8"));
  const label = (key) => messages[key].message;
  const fixture = await createNativeFixture();
  const set = (download, state = "downloading") => fixture.setState({component:{...fixture.state().component,state,runtime:null,download}});
  const initial = {status:"running",bytes_received:0,total_bytes:0,file:null,error:null,phase:"detecting"};
  const plan = {profile:"recommended",devices:["Apple GPU (MPS)","CPU (arm64)","<img src=x onerror=alert(1)>"],
    files:["model.safetensors","lid.176.bin","<script>not executable</script>"],total_bytes:1_430_000_000,expanded_bytes:3_000_000_000};
  const requests = () => fixture.requests().filter((r) => r.op === "models.download");
  set(initial);
  let context;
  try {
    const launched = await launchExtension({nativeFixture:fixture,extDir:EXT,...uiLanguage(language)});
    context = launched.context;
    assert.ok((await uiLanguageOf(launched.sw))?.toLowerCase().startsWith(language.toLowerCase().split("-")[0]));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror",(error) => errors.push(error.message));
    await page.goto(`chrome-extension://${launched.extId}/options.html`);
    const panel = page.locator("#componentSettings"), planPanel = page.locator("#downloadPlan");
    const button = (key) => panel.getByRole("button",{name:label(key),exact:true});
    await panel.locator(".component-status").filter({hasText:label("componentDetectingDevices")}).waitFor();
    assert.equal(await panel.locator("progress").getAttribute("value"),null,"Detection has no invented total or percentage");
    assert.equal(await button("componentPauseDownload").isEnabled(),true);
    assert.equal(await planPanel.isHidden(),true);
    assert.equal(requests().length,0,"Mount/poll does not initiate preparation");

    set({...initial,phase:"verifying",bytes_received:500_000_000,total_bytes:plan.total_bytes,plan});
    await button("componentRetryConnection").click();
    await planPanel.waitFor();
    await panel.locator(".component-status").filter({hasText:label("componentVerifyingModels")}).waitFor();
    assert.equal(await panel.locator("progress").getAttribute("value"),"500000000");
    assert.equal(await panel.locator("progress").getAttribute("max"),String(plan.total_bytes));
    assert.ok((await panel.locator(".component-download").innerText()).includes(label("componentVerifyingModels")));
    assert.ok((await panel.innerText()).includes(label("componentPreparationNote")));
    assert.ok((await planPanel.innerText()).includes("1.33 GiB"),"Selected total includes assets and LID");
    assert.ok((await planPanel.innerText()).includes("2.79 GiB"),"Expanded size is the total, not a delta");
    await planPanel.getByText(label("componentPlanFiles"),{exact:true}).click();
    await planPanel.getByRole("listitem").filter({hasText:plan.files[2]}).waitFor();
    assert.equal(await planPanel.getByRole("listitem").last().textContent(),plan.files[2]);
    assert.ok((await planPanel.innerText()).includes(plan.devices[2]));
    assert.equal(await planPanel.locator("img,script").count(),0,"Device names and filenames are text only");
    assert.equal(await button("componentExpandedDownload").isDisabled(),true);

    set({...initial,status:"completed",phase:"complete",bytes_received:plan.total_bytes,total_bytes:plan.total_bytes,plan},"stopped");
    await button("componentRetryConnection").click();
    await page.waitForFunction((text) => [...document.querySelectorAll("#downloadPlan button")].some((el) => el.textContent === text && !el.disabled),label("componentRecommendedDownload"));
    assert.equal(requests().length,0,"Completed setup still does not request expanded files automatically");
    await page.evaluate(readFileSync(join(ROOT,"node_modules/axe-core/axe.min.js"),"utf8"));
    for (const colorScheme of ["light","dark"]) {
      await page.emulateMedia({colorScheme});
      await page.waitForFunction((scheme) => document.documentElement.classList.contains("dark") === (scheme === "dark"),colorScheme);
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
      const violations = await page.evaluate(async () => (await axe.run("#componentSettings",{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa"]}})).violations.map((v) => ({id:v.id,nodes:v.nodes.map((n) => n.target)})));
      assert.deepEqual(violations,[],`${language} ${colorScheme} download-plan accessibility`);
    }
    await page.setViewportSize({width:400,height:900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
    assert.equal(await planPanel.getByRole("button").evaluateAll((buttons) => buttons.some((el) => el.scrollWidth > el.clientWidth)),false,"Long localized actions must wrap inside the plan card");
    await planPanel.screenshot({path:join(artifacts,`plan-${language}.png`)});

    await button("componentExpandedDownload").click();
    await panel.locator(".component-status").filter({hasText:label("componentDetectingDevices")}).waitFor();
    assert.deepEqual(requests().at(-1).payload,{profile:"expanded"});
    assert.equal(await button("componentPauseDownload").isEnabled(),true);
    const expandedPlan = {...plan,profile:"expanded",total_bytes:plan.expanded_bytes};
    set({...initial,status:"paused",phase:"verifying",bytes_received:plan.total_bytes,total_bytes:expandedPlan.total_bytes,plan:expandedPlan},"paused");
    await button("componentRetryConnection").click();
    await button("componentResumeDownload").click();
    await button("componentPauseDownload").waitFor();
    assert.deepEqual(requests().at(-1).payload,{},"Resume keeps the persisted profile");
    assert.equal(fixture.state().component.download.plan.profile,"expanded");
    await button("componentPauseDownload").click();
    await button("componentRecommendedDownload").click();
    await panel.locator(".component-status").filter({hasText:label("componentDetectingDevices")}).waitFor();
    assert.deepEqual(requests().at(-1).payload,{profile:"recommended"});
    assert.equal(fixture.state().component.storage.models_bytes,100,"Changing a plan does not delete existing models");

    set({status:"paused",bytes_received:50,total_bytes:100,file:null,error:null},"paused");
    await button("componentRetryConnection").click();
    assert.equal(await planPanel.isHidden(),true,"Older components without a plan remain supported");
    assert.equal(await button("componentResumeDownload").isVisible(),true);
    assert.equal(await launched.sw.evaluate(async () => (await chrome.permissions.getAll()).origins?.length ?? 0),0);
    assert.deepEqual(errors,[]);
    console.log(`PASS ${language}: detection, verification/reuse, explicit expanded/rescan, profile-preserving resume, legacy fallback, safe text, a11y and narrow layout`);
  } finally { await context?.close(); fixture.dispose(); }
}
