"""olmOCR-Bench's own checks over the reader's page texts (test/pdf-bench/olmocr.mjs).

  python3 olmocr-check.py <olmocr/bench/tests.py> <bench_data> <reading dir> [...] [--subsets a,b] [--split dev|test] [--failures <n>]

The test classes are upstream's, unchanged: allenai/olmocr's olmocr/bench/tests.py (Apache-2.0)
with its olmocr/repeatdetect.py beside it, executed here with the imports this does not need
(the maths renderer, the table parser) stubbed, so present, absent, order and the page's
baseline test are judged exactly as the published leaderboard judges them. Needs rapidfuzz and
fuzzysearch. A missing page file fails every test of that page, as upstream counts it. Prints
the pass rate per subset and per test type, and the first failures of each subset.
"""
import collections, hashlib, json, os, sys, types

args = [a for i, a in enumerate(sys.argv[1:]) if not a.startswith("--") and not (i > 0 and sys.argv[i].startswith("--"))]
flag = lambda name, default=None: sys.argv[sys.argv.index(f"--{name}") + 1] if f"--{name}" in sys.argv else default
tests_py, data, readings = args[0], args[1], args[2:]
subsets = flag("subsets", "headers_footers,long_tiny_text,multi_column").split(",")
show = int(flag("failures", "0"))
# The held-out rule of bench.mjs, on the page's file: "test" is a SHA-1 opening 0-4.
split = flag("split")
held_out = lambda pdf: hashlib.sha1(pdf.encode()).hexdigest()[0] in "01234"

# The upstream module, its package-relative imports answered by stubs or by its own neighbours.
source = open(tests_py).read()
repeat = types.ModuleType("olmocr.repeatdetect")
exec(open(os.path.join(os.path.dirname(tests_py), "repeatdetect.py")).read(), repeat.__dict__)
sys.modules["olmocr"] = types.ModuleType("olmocr")
sys.modules["olmocr.repeatdetect"] = repeat
source = source.replace("from .katex.render import compare_rendered_equations, render_equation", "compare_rendered_equations = render_equation = None")
source = source.replace("from .table_parsing import parse_html_tables, parse_markdown_tables", "parse_html_tables = parse_markdown_tables = None")
source = source.replace("from tqdm import tqdm", "tqdm = lambda items, **kw: items")
checker = types.ModuleType("olmocr_bench_tests")
sys.modules["olmocr_bench_tests"] = checker
exec(compile(source, tests_py, "exec"), checker.__dict__)

tests = []
for subset in subsets:
    for line in open(os.path.join(data, f"{subset}.jsonl")):
        if line.strip():
            t = checker.load_single_test(line)
            if split is None or held_out(t.pdf) == (split == "test"):
                tests.append((subset, t))
# Upstream adds a baseline test to every PDF that has none (benchmark.py).
have = {t.pdf for _, t in tests if t.type == "baseline"}
for subset, pdf in sorted({(s, t.pdf) for s, t in tests if t.pdf not in have}):
    tests.append((subset, checker.BaselineTest(id=f"{pdf}_baseline", pdf=pdf, page=1, type="baseline")))

for reading in readings:
    rate = collections.defaultdict(lambda: [0, 0])
    failures = collections.defaultdict(list)
    results = {}
    for subset, t in tests:
        file = os.path.join(reading, f"{t.pdf[:-4]}_pg{t.page}_repeat1.md")
        if os.path.exists(file):
            ok, why = t.run(open(file).read())
        else:
            ok, why = False, "missing"
        results[t.id] = {"subset": subset, "type": t.type, "pdf": t.pdf, "ok": ok, "why": why}
        for key in [(subset, t.type), (subset, "all"), ("all", t.type)]:
            rate[key][0] += ok
            rate[key][1] += 1
        if not ok:
            failures[subset].append((t.id, why))
    print(f"## {reading}")
    for (subset, kind), (passed, total) in sorted(rate.items()):
        print(f"{subset:16} {kind:9} {passed:4}/{total:<4} {100 * passed / total:5.1f}%")
    if show:
        for subset, rows in failures.items():
            print(f"-- {subset}: first {show} of {len(rows)} failures")
            for tid, why in rows[:show]:
                print(f"   {tid}: {why[:200]}")
    json.dump({"rates": {f"{s}/{k}": v for (s, k), v in rate.items()}, "tests": results}, open(os.path.join(reading, f"olmocr-results{'-' + split if split else ''}.json"), "w"), indent=1)
