"""Build-only pinned CGC grammar staging. Never run against review content."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import tempfile
import urllib.request
import os

VERSION = "1.22.1"
MANIFEST_SHA256 = "94b201d924980c2d32b509796ecaf943898f8d13e3220c5dfcf1ba94890c10d8"
NOTICES_SHA256 = "b836efa79163af6967db6ad761bb753e642fbb6c718df6fd4410d0aba29ebf90"
LANGUAGES = ["c", "cpp", "csharp", "go", "java", "javascript", "php", "python", "ruby", "rust", "tsx", "typescript"]
DESTINATION = Path("/opt/cgc-parsers") / f"v{VERSION}"


def main() -> None:
    if importlib.metadata.version("tree-sitter-language-pack") != VERSION:
        raise RuntimeError("unexpected CGC grammar package version")
    url = f"https://github.com/xberg-io/tree-sitter-language-pack/releases/download/v{VERSION}/parsers.json"
    with urllib.request.urlopen(url, timeout=60) as response:
        manifest = response.read(1024 * 1024 + 1)
    if len(manifest) > 1024 * 1024 or hashlib.sha256(manifest).hexdigest() != MANIFEST_SHA256:
        raise RuntimeError("CGC grammar manifest digest mismatch")
    if json.loads(manifest)["version"] != VERSION:
        raise RuntimeError("CGC grammar manifest version mismatch")
    url = f"https://raw.githubusercontent.com/xberg-io/tree-sitter-language-pack/v{VERSION}/sources/grammar_notices.json"
    with urllib.request.urlopen(url, timeout=60) as response:
        notices_bytes = response.read(4 * 1024 * 1024 + 1)
    if len(notices_bytes) > 4 * 1024 * 1024 or hashlib.sha256(notices_bytes).hexdigest() != NOTICES_SHA256:
        raise RuntimeError("CGC grammar notices digest mismatch")
    metadata = json.loads(notices_bytes)
    notices = [f"tree-sitter-language-pack {VERSION} grammar notices\n"]
    for language in LANGUAGES:
        item = metadata["languages"][language]
        notices.append(f"\n{language}: {item['repo']} at {item['rev']}\n")
        for file in item["license_files"]:
            text = metadata["licenses"][file["sha256"]]
            if hashlib.sha256(text.encode("utf-8")).hexdigest() != file["sha256"]:
                raise RuntimeError("CGC grammar license digest mismatch")
            notices.append(text)
    with tempfile.TemporaryDirectory(prefix="redline-grammar-build-") as temporary:
        root = Path(temporary)
        metadata = root / "parsers.json"
        metadata.write_bytes(manifest)
        # The package verifies platform bundle SHA256 against this pinned manifest.
        os.environ["TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL"] = metadata.as_uri()
        from tree_sitter_language_pack import PackConfig, cache_dir, configure, get_parser, prefetch

        configure(PackConfig(cache_dir=str(root / "cache")))
        prefetch(LANGUAGES)
        for language in LANGUAGES:
            get_parser(language).parse(b"")
        # Keep only runtime libraries, not download archives or writable build caches.
        shutil.copytree(Path(cache_dir()), DESTINATION)
    (DESTINATION / "NOTICE.txt").write_text("\n".join(notices), encoding="utf-8")
    for path in [DESTINATION, *DESTINATION.rglob("*")]:
        if path.is_symlink():
            raise RuntimeError("CGC parser staging contains a symlink")
        path.chmod(0o755 if path.is_dir() else 0o644)
    print(f"Staged {len(LANGUAGES)} pinned CGC grammars for offline use.")


if __name__ == "__main__":
    main()
