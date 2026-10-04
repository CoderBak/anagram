// test/perf-profile.mjs — which code ran in a page's longest tasks, from a profile the perf
// survey kept (SAVE_PROFILE in test/pw/perf-matrix.spec.mjs, test/perf-kit.mjs).
//
//   node test/perf-profile.mjs <profile.json> [how many long tasks, 5]
//
// The profile carries the page's long tasks, in the page's clock, and a mark the page put in
// it (anagramProfileMark, a busy function it timed): the mark ties the two clocks together.
// For each long task, the frames that ran in it, inclusive and self, in ms. "(program)" alone
// is the browser's own work (parsing, style, layout, paint); a chrome-extension:// frame is
// Anagram's. Minified names: read the bundle at the line and column given.
import { readFileSync } from "node:fs";

const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
const nodes = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const frames = (id) => { const st = []; for (let x = id; x !== undefined; x = parent.get(x)) st.push(nodes.get(x).callFrame); return st; };
const name = (f) => `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}:${f.columnNumber}`;
let t = p.startTime;
const samples = p.samples.map((id, i) => ({ id, t: (t += p.timeDeltas[i]) }));
const interval = (p.endTime - p.startTime) / 1000 / Math.max(1, samples.length);
const mark = samples.find((s) => frames(s.id).some((f) => f.functionName === "anagramProfileMark"));
if (!mark || !p.sync) throw new Error("no profile mark: keep profiles with SAVE_PROFILE in the perf survey");
for (const [start, duration] of [...p.lt].sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[3] ?? 5))) {
  const from = mark.t + (start - p.sync.epoch) * 1000, to = from + duration * 1000;
  const inTask = samples.filter((s) => s.t >= from && s.t <= to);
  const incl = new Map(), self = new Map();
  for (const s of inTask) {
    const st = frames(s.id);
    self.set(name(st[0]), (self.get(name(st[0])) ?? 0) + 1);
    for (const k of new Set(st.map(name))) incl.set(k, (incl.get(k) ?? 0) + 1);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(v * interval).toFixed(0)} ${k}`).join(" | ");
  console.log(`long task ${duration} ms`);
  console.log(`  inclusive: ${top(incl, 14)}`);
  console.log(`  self:      ${top(self, 8)}`);
}
