#!/usr/bin/env python3
"""Explicit native-host smoke against existing weights in a throwaway owned home.

Example: python test/native-real.py --python /path/to/private/python
  --model-dir /path/to/verified/modelkit --lid-model /path/to/lid.176.ftz
No downloads, browser registration, or real installed-home changes are required.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import select
import shutil
import struct
import subprocess
import tempfile
import time

DAEMON = Path(__file__).resolve().parents[1] / "anagramd"


class Client:
    def __init__(self, python, home, log):
        self.process = subprocess.Popen([str(python), "-I", "-u", str(home / "app/native_host.py"), "--home", str(home)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, cwd=home)
        self.sequence = 0

    def read_exact(self, size, timeout=30):
        result, end = b"", time.monotonic() + timeout
        while len(result) < size:
            remaining = end - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                raise TimeoutError("Native reply did not arrive")
            part = os.read(self.process.stdout.fileno(), size - len(result))
            if not part:
                raise RuntimeError(f"Native host exited: {self.process.poll()}")
            result += part
        return result

    def request(self, op, payload=None):
        self.sequence += 1
        request_id = f"smoke-{self.sequence}"
        body = json.dumps({"v": 1, "id": request_id, "op": op, "payload": payload or {}}).encode()
        self.process.stdin.write(struct.pack("=I", len(body)) + body)
        self.process.stdin.flush()
        size = struct.unpack("=I", self.read_exact(4))[0]
        assert 0 < size < 1024 * 1024, "stdout was not a bounded Native Messaging frame"
        response = json.loads(self.read_exact(size))
        assert response["id"] == request_id and response["v"] == 1, response
        return response

    def until(self, expected, timeout=240):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            response = self.request("status")
            assert response["ok"], response
            data = response["data"]
            if data["state"] in expected:
                return data
            assert data["state"] != "error", data
            time.sleep(0.2)
        raise TimeoutError("Native component did not reach " + repr(expected))

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=45)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--lid-model", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    pin = json.loads((DAEMON / "modelkit.json").read_text())
    probe = subprocess.run([str(args.python), "-I", "-B", "-c",
                            "import sys,json;from pathlib import Path;sys.path.insert(0,sys.argv[1]);"
                            "from model_plan import build_plan,discover_hardware;"
                            "from download_modelkit import load_pin,PIN;"
                            "print(json.dumps(build_plan(load_pin(PIN),discover_hardware())))", str(DAEMON)],
                           capture_output=True, text=True, check=True, timeout=60)
    expected_plan = json.loads(probe.stdout)
    report = {}
    with tempfile.TemporaryDirectory(prefix="anagram-native-smoke-") as temporary:
        home = Path(temporary).resolve() / "owned"
        (home / "app").mkdir(parents=True)
        (home / "models/editlens_roberta-large").mkdir(parents=True)
        (home / ".native-component.json").write_text(json.dumps(
            {"schema_version": 1, "host": "dev.coderbak.anagram", "home": str(home)}))
        for name in ("native_host.py", "native_component.py", "download_modelkit.py", "model_plan.py", "modelkit.json",
                     "runtime_controller.py", "runtime_adapters.py", "benchmark_worker.py", "scoring.py", "engine.py", "safe_files.py", "pyproject.toml"):
            shutil.copyfile(DAEMON / name, home / "app" / name)
        for entry in pin["files"]:
            if entry["path"] not in expected_plan["selected_paths"]:
                continue
            source = args.model_dir / entry["path"]
            assert source.is_file() and source.stat().st_size == entry["size_bytes"], str(source)
            target = home / "models/editlens_roberta-large" / entry["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            os.link(source, target)
        os.link(args.lid_model, home / "models/lid.176.ftz")
        # Explicit test fixture blocks network downloads. Production host code has
        # no environment switch or test mode that can bypass its pinned checks.
        fixture = home / "app/native-smoke-fixture.py"
        fixture.write_text("import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path(__file__).parent))\n"
                           "import download_modelkit\ndef no_network(*a,**k): raise AssertionError('smoke attempted a download')\n"
                           "download_modelkit.transfer_asset=no_network\nimport native_host\nnative_host.main()\n")
        # A separate fixture launcher changes only the test subprocess; the
        # production host has no download-verification bypass.
        class FixtureClient(Client):
            def __init__(self, python, home, log):
                self.process = subprocess.Popen([str(python), "-I", "-u", str(fixture), "--home", str(home)],
                                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, cwd=home)
                self.sequence = 0
        with (home / "native-smoke.log").open("wb") as log:
            client = None
            try:
                t0 = time.monotonic()
                client = FixtureClient(args.python, home, log)
                status = client.request("status")
                report["first_status_s"] = round(time.monotonic() - t0, 3)
                assert status["ok"], status
                peer = FixtureClient(args.python, home, log)
                try:
                    busy = peer.request("status")
                    assert not busy["ok"] and busy["status"] == 409 and busy["error"]["code"] == "busy", busy
                    assert peer.request("models.download")["error"]["code"] == "busy"
                finally:
                    peer.close()
                # Prepared files lead straight to an automatically selected, loaded runtime.
                ready = client.until({"ready"})
                report["setup_wall_s"] = round(time.monotonic() - t0, 3)
                report["download_plan"] = ready["download"].get("plan")
                assert set(report["download_plan"]) == {"devices", "total_bytes"}, report["download_plan"]
                for entry in pin["files"]:
                    if entry["path"] not in expected_plan["selected_paths"]:
                        assert not (home / "models/editlens_roberta-large" / entry["path"]).exists()
                runtime = ready["runtime"]
                assert runtime["benchmark"]["status"] == "idle" and runtime["benchmark"]["results"] == [], runtime
                assert runtime["active_id"] == runtime["selected_id"] == runtime["recommended_id"], runtime
                candidates = runtime["candidates"]
                chosen = next(c for c in candidates if c["id"] == runtime["active_id"])
                assert chosen["precision"] == "fp32" and chosen["available"], chosen
                assert json.loads((home / "runtime.json").read_text())["selected_id"] == runtime["active_id"]
                report["auto_selected_id"] = runtime["active_id"]
                # An explicit comparison measures every candidate elsewhere and keeps the selection.
                started = client.request("runtime.benchmark", {"budget_s": 10})
                assert started["ok"] and started["status"] == 202, started
                measured = client.until({"ready"})
                report["benchmark"] = measured["runtime"]["benchmark"]
                benchmark = report["benchmark"]
                assert benchmark["report_version"] == 2 and benchmark["status"] == "completed", benchmark
                assert benchmark["stale"] is False, benchmark
                rows = benchmark["results"]
                assert len(rows) == benchmark["total"] and rows, benchmark
                assert all(row["status"] == "ok" for row in rows), rows
                assert all(row["rss_scope"] == "isolated_process" and row["samples"] > 0 for row in rows), rows
                assert all(row["initialization_ms"] >= 0 and row["hash_ms"] >= 0 for row in rows), rows
                assert measured["runtime"]["active_id"] == runtime["active_id"], measured["runtime"]
                # An explicit switch is still available.
                desired = next((c["id"] for c in candidates if c["id"] == "torch:cpu:fp32" and c["available"]
                                and c["id"] != runtime["active_id"]), runtime["active_id"])
                selected = client.request("runtime.config", {"id": desired})
                assert selected["ok"] and selected["status"] == 202, selected
                assert client.until({"ready"})["runtime"]["active_id"] == desired
                health = client.request("health")
                assert health["ok"] and health["data"]["ok"], health
                version = health["data"]["model"]["ver"]
                human = ("I got the call around six, right when the rice was starting to catch on the bottom of the pan. "
                         "My brother never rings on weeknights, so I turned the burner off and sat on the floor to listen. "
                         "He talked for twenty minutes about a dog he was thinking of adopting and never mentioned the "
                         "thing we both knew he had rung to say. Afterwards the rice was ruined and I ate it anyway.")
                scored = client.request("score", {"v": "2.1", "blocks": [{"id": "human", "text": human},
                    {"id": "zh", "text": "这是一个完全用中文写成的段落。模型只在英文数据上训练过，所以这段文字不应该被打分。"}]})
                assert scored["ok"] and scored["data"]["results"][0]["bucket"] == 0, scored
                assert scored["data"]["results"][1]["unsupported"] is True, scored
                assert scored["data"]["model"]["ver"] == version
                report["selected_id"], report["model_version"] = desired, version
                client.request("engine.stop")
                client.until({"stopped"})
                assert client.request("health")["error"]["code"] == "not_ready"
                client.request("engine.resume")
                client.until({"ready"})
                assert client.request("health")["data"]["model"]["ver"] == version
                client.close()
                restart = time.monotonic()
                client = FixtureClient(args.python, home, log)
                restored = client.until({"ready"})
                report["restart_wall_s"] = round(time.monotonic() - restart, 3)
                assert restored["runtime"]["active_id"] == desired, restored["runtime"]
                assert restored["runtime"]["benchmark"]["results"] == report["benchmark"]["results"]
                assert client.request("health")["data"]["model"]["ver"] == version
                report["checks"] = ["framing", "responsive first status", "exclusive peer busy", "all local pinned files reused",
                                    "automatic FP32 selection", "explicit benchmark keeps selection", "explicit switch",
                                    "score + language gate", "engine stop/resume", "restart reuses selection", "no network"]
            except BaseException:
                log.flush()
                print((home / "native-smoke.log").read_text(errors="replace")[-12000:])
                raise
            finally:
                if client:
                    client.close()
    if args.report:
        args.report.write_text(json.dumps(report, indent=2))
    print(json.dumps({key: value for key, value in report.items() if key != "benchmark"}, indent=2))


if __name__ == "__main__":
    main()
