#!/usr/bin/env python3
"""Compatibility entrypoint for the shared, trusted code-context builder."""
import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True
_shared_path = Path(__file__).resolve().parents[2] / "src" / "code-index" / "export.py"
_spec = importlib.util.spec_from_file_location("redline_shared_code_context", _shared_path)
if _spec is None or _spec.loader is None:
    raise RuntimeError("shared code-context builder is unavailable")
_shared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_shared)


def __getattr__(name: str):
    return getattr(_shared, name)


if __name__ == "__main__":
    try:
        raise SystemExit(_shared.main())
    except (ValueError, OSError, RuntimeError) as error:
        print(f"redline code-index: {error}", file=sys.stderr)
        raise SystemExit(2) from error
