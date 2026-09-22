"""Terminal model preparation shared by installation and download-only repair."""
from __future__ import annotations

import argparse
import contextlib
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))


def prepare(home, *, installer=False, language="en", profile=None):
    from native_component import HomeLock, STATE_DEFAULT, validate_home
    from native_host import configure_environment
    from download_modelkit import (PIN, LID_ENTRY, LID_URL, load_pin, installed_profile,
                                   install_streaming, download_asset, invalid_files, matches)
    from safe_files import atomic_json, read_json, is_link
    from hub_transfer import safe_error

    home = validate_home(home)
    # The invoking installer holds the native lock (and POSIX startup barrier)
    # until this child exits. Standalone repair acquires the normal host lock.
    if installer and os.name == "posix":
        barrier = home / ".installer-lock"
        if is_link(barrier) or not barrier.is_dir():
            raise ValueError("Installer download requires the active installation barrier")
    lock = contextlib.nullcontext() if installer else contextlib.closing(HomeLock(home))
    with lock:
        configure_environment(home)
        os.chdir(home)
        model_dir = home / "models/editlens_roberta-large"
        state_path = home / "component-state.json"
        # The terminal may prepare the expanded set explicitly; the browser only
        # ever reuses whichever profile the installation records here.
        profile = profile or installed_profile(model_dir)
        state = read_json(state_path, max_bytes=65536) if state_path.exists() else dict(STATE_DEFAULT)
        if installer and (state["models_deleted"] or state["download_paused"]):
            print("Keeping your paused download / removed-model preference. Resume from Settings when ready."
                  if language == "en" else "保留暂停下载或已删除模型的选择；需要时请在设置中恢复。", flush=True)
            return
        say = lambda en, zh: print(zh if language == "zh_CN" else en, flush=True)
        say("Detecting usable devices…", "正在检测可用计算设备…")
        from model_plan import build_plan, discover_hardware
        pin = load_pin(PIN)
        plan = build_plan(pin, discover_hardware(), profile)
        total = plan["total_bytes"] + LID_ENTRY["size_bytes"]
        say("Devices: " + " · ".join(plan["devices"]), "设备：" + " · ".join(plan["devices"]))
        say(f"Model files: {total / 1e9:.2f} GB; verified files will be reused.\nDestination: {model_dir}",
            f"模型文件共 {total / 1e9:.2f} GB；复用已校验文件。\n保存位置：{model_dir}")
        for name in [*plan["selected_paths"], "lid.176.ftz"]:
            print("  " + name, flush=True)
        state.update(initialized=True, download_pending=True, download_failed=False,
                     download_paused=False, models_deleted=False, model_profile=profile)
        atomic_json(state_path, state)
        started = time.monotonic()
        last_time, last_name = 0.0, None

        def progress(received, size, name):
            nonlocal last_time, last_name
            now = time.monotonic()
            if name != last_name or now - last_time >= 1 or received == size:
                print(f"[{100 * received / max(size, 1):5.1f}%] {received / 1e6:,.1f} / {size / 1e6:,.1f} MB"
                      f" · {name or 'SHA-256 verified'} · {now - started:.0f}s", flush=True)
                last_time, last_name = now, name

        try:
            install_streaming(model_dir, pin, selected_paths=plan["selected_paths"],
                              progress=lambda got, _total, name: progress(got, total, name))
            lid = home / "models/lid.176.ftz"
            download_asset(LID_URL, lid, LID_ENTRY,
                           progress=lambda got: progress(plan["total_bytes"] + got, total, "lid.176.ftz"))
            if invalid_files(model_dir, pin, plan["selected_paths"]) or not matches(lid, LID_ENTRY):
                raise ValueError("Downloaded files failed SHA-256 verification")
        except (Exception, KeyboardInterrupt) as exc:
            state.update(download_pending=False, download_failed=True)
            atomic_json(home / "download-error.json", {"message": safe_error(exc) or "Download interrupted"})
            atomic_json(state_path, state)
            say("Download incomplete. Verified files and partial bytes are retained.",
                "下载未完成。已校验文件与未完成的下载均已保留。")
            print(safe_error(exc) or "Interrupted", file=sys.stderr)
            script = Path(__file__).resolve()
            if os.name == "posix":
                import shlex
                command = (shlex.quote(str(home / "bin/anagram")) + " download"
                           if script.parent == home / "app" else shlex.join([
                               sys.executable, "-I", str(script), "--home", str(home), "--language", language]))
            else:
                quote = lambda value: "'" + str(value).replace("'", "''") + "'"
                command = f"& {quote(sys.executable)} -I {quote(script)} --home {quote(home)} --language {language}"
            say("Close the browser's Anagram connection, then resume only the download (no reinstall):\n" + command,
                "关闭浏览器中的 Anagram 连接后，只恢复下载，无需重新安装：\n" + command)
            raise SystemExit(130 if isinstance(exc, KeyboardInterrupt) else 1)
        state.update(download_pending=False, download_failed=False, download_paused=False)
        atomic_json(state_path, state)
        say("Models verified. Return to the browser; Anagram finishes setup automatically.",
            "模型校验完成。请返回浏览器，Anagram 会自动完成设置。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--language", choices=("en", "zh_CN"), default="en")
    parser.add_argument("--profile", choices=("recommended", "expanded"),
                        help="Model set to prepare (default: the installed profile, initially recommended)")
    parser.add_argument("--installer", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        prepare(args.home, installer=args.installer, language=args.language, profile=args.profile)
    except Exception as exc:
        from hub_transfer import safe_error
        print(safe_error(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
