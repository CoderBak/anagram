"""Offline source-policy checks; stdlib only, no inference imports or downloads.

These regressions pin our own model-loading policy, per flavor, as PRIVACY.md
promises it: the native engine's "offline mode" (anagramd/), and the oneclick
flavor's in-browser engine (lib/webengine/), whose only network use is the
one-time download of the pinned model from Hugging Face. They are not a sandbox
or an audit of the transitive dependencies.
"""
import ast
import json
import re
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
INFERENCE = ("engine.py", "runtime_adapters.py", "scoring.py", "mlx_roberta.py",
             "benchmark_worker.py", "model_plan.py")


def source(name):
    return ast.parse((ROOT / "anagramd" / name).read_text(), filename=name)


class NetworkPrivacyTests(unittest.TestCase):
    def test_engine_overrides_online_environment_before_model_imports(self):
        tree = source("engine.py")
        policy = next(node for node in tree.body if isinstance(node, ast.For)
                      and isinstance(node.target, ast.Name)
                      and node.target.id == "_offline_var")
        required = {"HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE",
                    "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_IMPLICIT_TOKEN"}
        # Execute only the policy AST against a fake environment. In particular,
        # do not import engine, Torch, Transformers or any installed model.
        environment = dict.fromkeys(required, "0")
        exec(compile(ast.Module(body=[policy], type_ignores=[]), "offline-policy", "exec"),
             {"os": SimpleNamespace(environ=environment)})
        self.assertEqual({name: environment[name] for name in required},
                         dict.fromkeys(required, "1"))
        library_imports = [node.lineno for node in ast.walk(tree)
                           if isinstance(node, ast.ImportFrom)
                           and (node.module or "").split(".")[0] in
                           {"transformers", "huggingface_hub"}]
        self.assertTrue(library_imports)
        self.assertLess(policy.end_lineno, min(library_imports))

    def test_every_transformers_load_requires_local_files_and_forbids_remote_code(self):
        calls = []
        for name in INFERENCE:
            for node in ast.walk(source(name)):
                if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                        and node.func.attr == "from_pretrained"):
                    calls.append((name, node))
        self.assertTrue(calls, "No model/tokenizer loads were inspected")
        for name, call in calls:
            with self.subTest(file=name, line=call.lineno):
                keywords = {value.arg: value.value for value in call.keywords}
                self.assertIs(ast.literal_eval(keywords["local_files_only"]), True)
                self.assertIs(ast.literal_eval(keywords["trust_remote_code"]), False)

    def test_inference_modules_do_not_import_network_clients(self):
        # Explicit downloads live in download_modelkit.py and the installer.
        # This catches accidental direct HTTP/socket clients in the inference
        # layer, not calls hidden inside libraries or arbitrary dynamic imports.
        network_modules = {"socket", "http", "urllib", "requests", "httpx",
                           "aiohttp", "websockets", "ftplib", "smtplib"}
        imports = []
        for name in INFERENCE:
            for node in ast.walk(source(name)):
                modules = ([entry.name for entry in node.names] if isinstance(node, ast.Import)
                           else [node.module or ""] if isinstance(node, ast.ImportFrom) else [])
                imports.extend((name, node.lineno, module) for module in modules
                               if module.split(".")[0] in network_modules)
        self.assertEqual(imports, [])

    def test_only_the_download_transport_imports_an_http_client(self):
        # "The engine uses the network only to download model files and updates you
        # request." Downloads run in hub_transfer.py, in a process of its own; an update
        # runs the installer's maintenance helper. No other engine module imports a network
        # client. URL parsing is not one.
        network_modules = {"socket", "ssl", "http", "urllib", "requests", "httpx", "aiohttp",
                           "websockets", "ftplib", "smtplib", "huggingface_hub"}
        importers = set()
        for path in sorted((ROOT / "anagramd").glob("*.py")):
            for node in ast.walk(source(path.name)):
                modules = ([entry.name for entry in node.names] if isinstance(node, ast.Import)
                           else [node.module or ""] if isinstance(node, ast.ImportFrom) else [])
                if any(module.split(".")[0] in network_modules and module != "urllib.parse"
                       for module in modules):
                    importers.add(path.name)
        self.assertEqual(importers, {"hub_transfer.py"})


def web_engine_sources():
    """The oneclick flavor's engine: its transport and its offscreen document."""
    roots = [ROOT / "lib" / "webengine", ROOT / "entrypoints" / "engine"]
    return sorted(path for root in roots if root.exists() for path in root.rglob("*")
                  if path.suffix in {".ts", ".html"})


class InBrowserEnginePrivacyTests(unittest.TestCase):
    """The oneclick flavor scores in the browser and downloads its files once."""

    def test_no_host_permission_is_declared_for_the_download(self):
        # Hugging Face answers the engine with CORS headers and the language identifier
        # ships in the package, so neither flavor names a model host among its permissions.
        for path in (ROOT / "lib" / "access" / "patterns.ts", ROOT / "wxt.config.ts"):
            with self.subTest(file=str(path.relative_to(ROOT))):
                self.assertNotRegex(path.read_text(), r"huggingface|hf\.co|fbaipublicfiles|MODEL_HOSTS")

    def test_the_engine_addresses_only_the_download_hosts(self):
        # Page text never leaves the browser: any address the engine writes down is one
        # of the model's download hosts, and never a loopback or other inference server.
        # Comment lines are the attributions THIRD_PARTY_NOTICES.md requires of the
        # adapted code (test/node/notices.test.ts) and name nothing the code reaches.
        allowed = re.compile(r"^https://(huggingface\.co|[\w.-]+\.hf\.co)/")
        sources = web_engine_sources()
        self.assertTrue(sources, "No in-browser engine source was inspected")
        for path in sources:
            code = "\n".join(line for line in path.read_text().splitlines() if not line.lstrip().startswith(("//", "*", "<!--")))
            for url in re.findall(r"""(?:https?|wss?)://[^\s"'`)]+""", code):
                with self.subTest(file=str(path.relative_to(ROOT)), url=url):
                    self.assertRegex(url, allowed)

    def test_the_engine_opens_no_socket_beacon_or_native_port(self):
        forbidden = re.compile(r"\b(WebSocket|EventSource|sendBeacon|connectNative|RTCPeerConnection)\b")
        for path in web_engine_sources():
            with self.subTest(file=str(path.relative_to(ROOT))):
                self.assertIsNone(forbidden.search(path.read_text()))

    def test_the_engine_downloads_the_pinned_modelkit_revision(self):
        # Where the engine names a Hugging Face repository it is the pinned modelkit at its
        # pinned revision (anagramd/modelkit.json), the same files the native engine verifies.
        pin = json.loads((ROOT / "anagramd" / "modelkit.json").read_text())
        for path in web_engine_sources():
            text = path.read_text()
            for repository in re.findall(r"huggingface\.co/([\w.-]+/[\w.-]+)/resolve/", text):
                with self.subTest(file=str(path.relative_to(ROOT))):
                    self.assertEqual(repository, pin["repository"])
                    self.assertIn(pin["revision"], text)


if __name__ == "__main__":
    unittest.main()
