#!/usr/bin/env python3
"""Compatibility entrypoint for the shared, trusted code-context builder."""
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

sys.dont_write_bytecode = True


def _load_shared() -> ModuleType:
    shared_path = Path(__file__).resolve().parents[2] / "src" / "code-index" / "export.py"
    spec = importlib.util.spec_from_file_location("redline_shared_code_context", shared_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("shared code-context builder is unavailable")
    shared = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shared)
    return shared


def __getattr__(name: str):
    return getattr(_shared, name)


if __name__ == "__main__":
    try:
        _shared = _load_shared()
        raise SystemExit(_shared.main())
    except (ValueError, OSError, RuntimeError) as error:
        print(f"redline code-index: {error}", file=sys.stderr)
        raise SystemExit(2) from error
else:
    _shared = _load_shared()
