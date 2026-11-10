"""Offline check of the pinned parser package's manifest override and bundle hash enforcement."""
import importlib.metadata
import json
import os
from pathlib import Path
import tempfile


def main() -> None:
    """Reject a corrupt local bundle before any grammar can be staged or loaded."""
    if importlib.metadata.version("tree-sitter-language-pack") != "1.22.1":
        raise RuntimeError("unexpected parser package version")
    with tempfile.TemporaryDirectory(prefix="redline-grammar-integrity-") as temporary:
        root = Path(temporary)
        bundle = root / "corrupt.tar.zst"
        bundle.write_bytes(b"synthetic corrupt grammar bundle")
        manifest = root / "parsers.json"
        entry = {"url": bundle.as_uri(), "sha256": "0" * 64, "size": bundle.stat().st_size}
        manifest.write_text(json.dumps({
            "version": "1.22.1",
            "platforms": {"linux-x86_64": entry, "linux-aarch64": entry},
            "languages": {"python": {"group": "all", "size": 1}},
            "groups": {"all": ["python"]},
        }), encoding="utf-8")
        os.environ["TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL"] = manifest.as_uri()
        os.environ["TREE_SITTER_LANGUAGE_PACK_LIBS_DIR"] = str(root / "empty-libraries")
        os.environ["TREE_SITTER_LANGUAGE_PACK_CACHE_DIR"] = str(root / "cache")
        from tree_sitter_language_pack import PackConfig, configure, prefetch

        configure(PackConfig(cache_dir=str(root / "cache")))
        try:
            prefetch(["python"])
        except Exception as error:
            if "checksum" not in str(error).lower():
                raise RuntimeError("parser package did not reject the supplied bundle digest") from error
        else:
            raise RuntimeError("parser package accepted a corrupt grammar bundle")
        if any(path.suffix in {".so", ".dylib", ".dll"} for path in root.rglob("*")):
            raise RuntimeError("a parser library was staged before digest validation")
    print("Pinned manifest override honored; corrupt bundle rejected before staging.")


if __name__ == "__main__":
    main()
