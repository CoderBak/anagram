"""Measure the existing modelkit converter in isolated processes; never installs a model.

Run with the modelkit build environment. The output directory must not exist.
The modelkit retains its upstream CC-BY-NC-SA-4.0 license and attribution.
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

import psutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--modelkit", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / "upstream").mkdir()
    shutil.copy(args.modelkit / "upstream/metadata.json", args.output / "upstream/metadata.json")
    shutil.copytree(args.modelkit / "validation", args.output / "validation")
    report = {"platform": platform.platform(), "python": sys.version, "method": "One fresh process per stage; process RSS sampled every 20 ms. No filesystem-cache flush. Conversion checks are engineering parity, not accuracy evaluation.", "stages": []}
    stages = [(name, [str(args.modelkit / "scripts/build.py"), name, "--source", str(args.source), "--output", str(args.output)]) for name in ("export", "fp16", "int8")]
    stages += [("verify-" + name, [str(args.modelkit / "scripts/validate.py"), name, "--root", str(args.output)]) for name in ("fp32", "fp16", "int8")]
    for name, command in stages:
        print(f"Starting {name}", flush=True)
        start = time.perf_counter(); peak = 0
        with (args.output / f"{name}.log").open("w") as log:
            process = subprocess.Popen([sys.executable, *command], stdout=log, stderr=subprocess.STDOUT, env={**os.environ, "HF_HUB_OFFLINE": "1", "TOKENIZERS_PARALLELISM": "false"})
            tracked = psutil.Process(process.pid)
            while process.poll() is None:
                try: peak = max(peak, tracked.memory_info().rss)
                except psutil.NoSuchProcess: pass
                time.sleep(.02)
            row = {"stage": name, "seconds": round(time.perf_counter() - start, 3), "peak_sampled_rss_bytes": peak, "exit_code": process.returncode}
        report["stages"].append(row)
        report["generated_bytes"] = sum(p.stat().st_size for p in (args.output / "onnx").glob("*"))
        (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(row), flush=True)
        if process.returncode: raise SystemExit(f"{name} failed; see {args.output / (name + '.log')}")


if __name__ == "__main__": main()
