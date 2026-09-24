"""Offline source-policy checks; stdlib only, no inference imports or downloads.

These regressions pin our own model-loading policy, the "offline mode" that
PRIVACY.md promises. They are not a sandbox or an audit of the transitive
dependencies.
"""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
INFERENCE = ("engine.py", "runtime_adapters.py", "scoring.py",
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


if __name__ == "__main__":
    unittest.main()
