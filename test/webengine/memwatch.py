#!/usr/bin/env python3
"""Peak memory of a browser's processes on macOS, for test/webengine/parity.mjs.

  python3 test/webengine/memwatch.py <substring of the command line> <out.json> [interval s]

Every process whose command line holds the substring (a temporary profile directory)
is sampled through proc_pid_rusage: `phys_footprint` is what Activity Monitor calls
Memory and includes the Metal buffers a process owns, which resident size does not.
Peaks per process kind (browser, renderer, gpu-process, utility; Firefox's content and
GPU helpers) are written to out.json on SIGTERM. Stock python3; no dependencies.
"""
import ctypes
import json
import signal
import subprocess
import sys
import time

_lib = ctypes.CDLL("/usr/lib/libproc.dylib")
_FIELDS = ["user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size",
           "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime", "child_user_time",
           "child_system_time", "child_pkg_idle_wkups", "child_interrupt_wkups", "child_pageins",
           "child_elapsed_abstime", "diskio_bytesread", "diskio_byteswritten", "qos_default", "qos_maintenance",
           "qos_background", "qos_utility", "qos_legacy", "qos_user_initiated", "qos_user_interactive",
           "billed_system_time", "serviced_system_time", "logical_writes", "lifetime_max_phys_footprint",
           "instructions", "cycles", "billed_energy", "serviced_energy", "interval_max_phys_footprint",
           "runnable_time", "flags"]


class RusageV4(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(f, ctypes.c_uint64) for f in _FIELDS]


def usage(pid):
    info = RusageV4()
    if _lib.proc_pid_rusage(int(pid), 4, ctypes.byref(info)) != 0:
        return None
    return info.resident_size, info.phys_footprint, info.lifetime_max_phys_footprint


def processes(substring):
    out = subprocess.run(["ps", "-Ao", "pid=,command="], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition(" ")
        if substring in cmd and "memwatch.py" not in cmd:
            rows.append((int(pid), cmd))
    return rows


def kind(cmd):
    for key in ("gpu-process", "renderer", "utility", "zygote"):
        if f"--type={key}" in cmd:
            return key
    if "GPU Helper" in cmd or "gpu-helper" in cmd:
        return "gpu-process"
    if "plugin-container" in cmd:
        return "content:" + cmd.rsplit(" ", 1)[-1]
    if "--type=" in cmd:
        return cmd.split("--type=")[1].split()[0]
    return "browser"


def main():
    substring, out = sys.argv[1], sys.argv[2]
    interval = float(sys.argv[3]) if len(sys.argv) > 3 else 0.25
    stop = [False]
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__(0, True))
    signal.signal(signal.SIGINT, lambda *_: stop.__setitem__(0, True))
    peaks, total_peak, listed, procs = {}, 0, 0.0, []
    while not stop[0]:
        if time.time() - listed > 1.0:
            procs, listed = processes(substring), time.time()
        total = 0
        for pid, cmd in procs:
            u = usage(pid)
            if not u:
                continue
            k = kind(cmd)
            entry = peaks.setdefault(k, {"rss": 0, "phys": 0, "lifetime_max_phys": 0})
            entry["rss"] = max(entry["rss"], u[0])
            entry["phys"] = max(entry["phys"], u[1])
            entry["lifetime_max_phys"] = max(entry["lifetime_max_phys"], u[2])
            total += u[1]
        total_peak = max(total_peak, total)
        time.sleep(interval)
    with open(out, "w") as f:
        json.dump({"kinds": peaks, "total_phys_peak": total_peak}, f, indent=1)


if __name__ == "__main__":
    main()
