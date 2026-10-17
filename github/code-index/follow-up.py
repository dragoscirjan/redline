#!/usr/bin/env python3
"""Trusted action-owned follow-up queries against the pinned base graph.

This module is never invoked by a model or from pull-request source. A fixed
query is generated for each validated candidate intent. Base-graph facts are
returned only with independently readable head-source anchors; the review
core re-resolves every anchor from its own captured source before use.
"""

import argparse
from hashlib import sha256
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import export as index

MAX_INPUT_BYTES = 128 * 1024
MAX_RESULT_BYTES = 256 * 1024
PER_QUERY_SECONDS = 20
MAX_REQUESTS = 2
REQUEST_ID = re.compile(r"related-span:sha256:[a-f0-9]{64}\Z")
CANDIDATE_ID = re.compile(r"f-[a-f0-9]{24}\Z")
FILE_ID = re.compile(r"[0-9]{6}\Z")


def load_json(path: Path, limit: int) -> Any:
    if path.is_symlink() or path.stat().st_size > limit:
        raise ValueError("follow-up input exceeds its size limit or is a symlink")
    return json.loads(path.read_text(encoding="utf-8"))


def validate_batch(value: Any, args: argparse.Namespace) -> list[dict[str, Any]]:
    if not isinstance(value, dict) or set(value) != {
        "version", "repository", "base", "head", "requests", "omitted"
    }:
        raise ValueError("invalid follow-up batch envelope")
    if value["version"] != 1 or any(value[key] != getattr(args, key) for key in ("repository", "base", "head")):
        raise ValueError("follow-up snapshot identity differs from the action")
    manifest = load_json(Path(args.review_dir) / "manifest.json", MAX_RESULT_BYTES)
    if not isinstance(manifest, dict) or manifest.get("base") != args.base or manifest.get("head") != args.head:
        raise ValueError("review bundle revision differs from the action")
    files = manifest.get("files")
    if not isinstance(files, list):
        raise ValueError("review bundle has no bounded manifest files")
    requests = value["requests"]
    if not isinstance(requests, list) or len(requests) > MAX_REQUESTS:
        raise ValueError("follow-up request limit exceeded")
    omitted = value["omitted"]
    if type(omitted) is not int or omitted < 0 or omitted > 4:
        raise ValueError("invalid omitted request count")
    seen: set[str] = set()
    batch_file: tuple[str, str] | None = None
    for request in requests:
        if not isinstance(request, dict) or set(request) != {
            "id", "candidateId", "fileId", "changedPath", "capability", "direction", "depth", "fanOut", "resultLimit"
        }:
            raise ValueError("invalid follow-up request")
        file_id = request["fileId"]
        candidate_id = request["candidateId"]
        identifier = request["id"]
        if (not isinstance(identifier, str) or not REQUEST_ID.fullmatch(identifier)
            or identifier in seen or not isinstance(candidate_id, str)
            or not CANDIDATE_ID.fullmatch(candidate_id) or not isinstance(file_id, str)
            or not FILE_ID.fullmatch(file_id)):
            raise ValueError("invalid or duplicate follow-up request identity")
        changed = index.repository_path(request["changedPath"])
        if not any(isinstance(item, dict) and item.get("id") == file_id
                   and (item.get("newPath") or item.get("oldPath")) == changed
                   and item.get("reviewed") is True for item in files):
            raise ValueError("follow-up file is not a reviewed change")
        if batch_file is None:
            batch_file = (file_id, changed)
        if (batch_file != (file_id, changed) or request["capability"] != "related-spans"
            or request["direction"] not in ("incoming", "outgoing")
            or type(request["depth"]) is not int or request["depth"] != 1
            or type(request["fanOut"]) is not int or request["fanOut"] != 8
            or type(request["resultLimit"]) is not int or request["resultLimit"] != 8):
            raise ValueError("follow-up requested an unsupported query or budget")
        serialized = json.dumps([args.repository, args.base, args.head, file_id,
                                 candidate_id, changed, request["direction"]],
                                ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if identifier != "related-span:sha256:" + sha256(serialized).hexdigest():
            raise ValueError("follow-up request identity is not canonical")
        seen.add(identifier)
    return requests


def check_graph(args: argparse.Namespace, runtime: Path) -> tuple[bool, str]:
    cache = runtime / "cache"
    source = runtime / "source"
    control = runtime / "control"
    state = index.read_cache_state(cache / "state.json")
    config_file = control / "config-id"
    index.PROVIDER_ID = args.provider
    index.PROVIDER_VERSION = "0.5.7" if args.provider == "cgc" else "1.6.12"
    if config_file.is_symlink() or not config_file.is_file():
        return False, "not-configured"
    config_id = config_file.read_text(encoding="utf-8")
    if (not index.compatible_cache_state(state, args.repository, config_id, source)
        or state["revision"] != args.base or not index.provider_cache_tree_safe(args.provider, cache)):
        return False, "snapshot-stale"
    if not (runtime / "head-source").is_dir():
        return False, "source-unavailable"
    return True, ""


def execute_request(request: dict[str, Any], args: argparse.Namespace, runtime: Path) -> dict[str, Any]:
    started = time.monotonic_ns()
    if Path(request["changedPath"]).suffix.lower() not in index.SUPPORTED_SUFFIXES:
        return {"requestId": request["id"], "status": "unsupported",
                "reason": "language-unsupported", "durationMs": 0, "spans": []}
    status = "unavailable"
    reason: str | None = "query-failed"
    spans: list[dict[str, Any]] = []
    try:
        control = runtime / "control"
        executable = Path((control / "executable").read_text(encoding="utf-8"))
        runtime_executable = Path((control / "runtime-executable").read_text(encoding="utf-8")) if args.provider == "gitnexus" else executable
        adapter = Path(__file__).parent / "gitnexus-query.mjs"
        if (not executable.is_absolute() or executable.is_symlink() or not executable.is_file()
            or (args.provider == "gitnexus" and (not runtime_executable.is_absolute()
                or runtime_executable.is_symlink() or not runtime_executable.is_file()))):
            raise ValueError("invalid provider executable")
        source = runtime / "source"
        head_source = runtime / "head-source"
        provider_path = str(source / request["changedPath"]) if args.provider == "cgc" else request["changedPath"]
        query = index.relationship_query(args.provider, [provider_path], request["direction"])
        # The provider returns one extra row as a truncation sentinel. No
        # partial result can become confirmation when that sentinel appears.
        query = query.rsplit("LIMIT ", 1)[0] + "LIMIT 9"
        environment = index.provider_environment(args.provider, runtime / "home", runtime / "cache")
        if args.provider == "gitnexus":
            environment["GITNEXUS_HOME"] = str(runtime / "cache" / "gitnexus-home")
        ok, raw = index.run_provider(index.provider_query_command(
            args.provider, executable, runtime_executable, adapter, source, query,
        ), environment, PER_QUERY_SECONDS, json_output=True)
        if not ok:
            raise ValueError("provider query failed")
        rows, invalid = index.normalize_rows(args.provider, raw, request["direction"], source,
                                            {provider_path: request["changedPath"]})
        if invalid or len(raw) > 8 or len(rows) > 8:
            status, reason = "partial", "result-truncated" if len(raw) > 8 else "path-ambiguous"
        else:
            resolved: list[dict[str, Any]] = []
            for row in rows:
                candidate = index.safe_source_file(head_source, row["path"])
                if candidate is None or candidate.stat().st_size > index.MAX_SOURCE_FILE_BYTES:
                    status, reason = "partial", "source-unavailable"
                    break
                lines = candidate.read_text(encoding="utf-8").splitlines()
                if row["startLine"] < 1 or row["endLine"] > len(lines) or row["endLine"] - row["startLine"] >= 20:
                    status, reason = "partial", "source-unavailable"
                    break
                evidence = lines[row["startLine"] - 1].rstrip("\r")
                if not evidence or len(evidence.encode("utf-8")) > 512:
                    status, reason = "partial", "source-unavailable"
                    break
                resolved.append({"path": row["path"], "revision": args.head,
                                 "startLine": row["startLine"], "endLine": row["endLine"],
                                 "evidence": evidence, "relationship": row["reason"]})
            else:
                spans = resolved
                status, reason = "complete", None
    except (OSError, UnicodeDecodeError, ValueError, IndexError):
        pass
    elapsed = max(0, (time.monotonic_ns() - started) // 1_000_000)
    if elapsed > PER_QUERY_SECONDS * 1000:
        status, reason, spans = "unavailable", "query-timed-out", []
    return {"requestId": request["id"], "status": status, "reason": reason,
            "durationMs": min(elapsed, PER_QUERY_SECONDS * 1000), "spans": spans}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("provider", "repository", "base", "head", "review-dir", "runner-temp", "input", "output"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    if args.provider not in ("cgc", "gitnexus") or not index.COMMIT_RE.fullmatch(args.base) or not index.COMMIT_RE.fullmatch(args.head):
        raise ValueError("invalid action provider or revision")
    batch = load_json(Path(args.input), MAX_INPUT_BYTES)
    requests = validate_batch(batch, args)
    runtime = Path(args.runner_temp) / "redline-code-index"
    available, unavailable_reason = check_graph(args, runtime)
    if available:
        results = [execute_request(request, args, runtime) for request in requests]
    else:
        results = [{"requestId": request["id"], "status": "unavailable",
                    "reason": unavailable_reason, "durationMs": 0, "spans": []} for request in requests]
    artifact = {"version": 1, "repository": args.repository, "base": args.base,
                "head": args.head, "provider": {"id": args.provider, "version": index.PROVIDER_VERSION},
                "snapshot": args.base, "results": results}
    encoded = (json.dumps(artifact, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(encoded) > MAX_RESULT_BYTES:
        raise ValueError("follow-up result exceeds output budget")
    Path(args.output).write_bytes(encoded)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, TypeError, KeyError) as error:
        print(f"follow-up unavailable: {type(error).__name__}", file=sys.stderr)
        sys.exit(2)
