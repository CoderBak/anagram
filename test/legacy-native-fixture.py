"""Run the historical EditLens host benchmarks with their pinned model and offline assets."""
from functools import partial
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import download_modelkit
import native_component
import native_host


def no_network(*args, **kwargs):
    raise AssertionError("The offline benchmark attempted a model download")


download_modelkit.transfer_asset = no_network
native_component.NativeComponent = partial(native_component.NativeComponent, pin=download_modelkit.load_pin(download_modelkit.PIN))
native_host.main()
