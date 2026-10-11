#!/usr/bin/env python3
"""Build Redline's bounded code-context artifact from a pinned CGC index."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable

VERSION = 1
PROVIDER_ID = "cgc"
PROVIDER_VERSION = "0.5.7"
MAX_ARTIFACT_BYTES = 128 * 1024
MAX_CHANGED_FILES = 256
MAX_CHANGED_PATH_BYTES = 48 * 1024
MAX_CONTEXTS = 64
MAX_CONTEXTS_PER_FILE = 8
MAX_CONTEXT_LINES = 80
MAX_CONTEXT_SOURCE_BYTES = 48 * 1024
MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024
MAX_RELATED_PATH_BYTES = 32 * 1024
MAX_QUERY_BYTES = 64 * 1024
MAX_QUERY_OUTPUT_BYTES = 1024 * 1024
MAX_DIAGNOSTICS = 20
MAX_DIAGNOSTIC_BYTES = 512
MAX_DATABASE_ENTRIES = 100_000
QUERY_ROW_LIMIT = MAX_CONTEXTS + 1
COMMIT_RE = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
CODE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SUPPORTED_SUFFIXES = frozenset(
    {
        ".c", ".cc", ".cpp", ".cs", ".cxx", ".dart", ".ex", ".exs", ".go",
        ".h", ".hh", ".hpp", ".java", ".js", ".jsx", ".kt", ".kts", ".lua",
        ".php", ".py", ".rb", ".rs", ".scala", ".sc", ".sh", ".sol", ".swift",
        ".ts", ".tsx",
    }
)


def monotonic_ms() -> int:
    return time.monotonic_ns() // 1_000_000


def utf8_size(value: str) -> int:
    return len(value.encode("utf-8"))


def path_sort_key(value: str) -> bytes:
    return value.encode("utf-8")


def validate_identity(base: str, head: str, repository: str) -> tuple[str, str, str]:
    if not COMMIT_RE.fullmatch(base) or not COMMIT_RE.fullmatch(head):
        raise ValueError("base and head must be full SHA-1 or SHA-256 commit identifiers")
    if not REPOSITORY_RE.fullmatch(repository):
        raise ValueError("repository must use owner/name form")
    return base.lower(), head.lower(), repository


def checked_output_directory(raw_output: str, raw_workspace: str) -> Path:
    workspace = Path(raw_workspace).resolve(strict=True)
    if not workspace.is_dir() or workspace.is_symlink():
        raise ValueError("workspace must be a regular directory")
    output = Path(raw_output)
    if not output.is_absolute():
        output = workspace / output
    output = output.resolve(strict=False)
    try:
        output.relative_to(workspace)
    except ValueError as error:
        raise ValueError("output directory must stay within the GitHub workspace") from error

    current = workspace
    for segment in output.relative_to(workspace).parts:
        current = current / segment
        if current.exists() and current.is_symlink():
            raise ValueError("output directory must not traverse a symlink")
    output.mkdir(parents=True, exist_ok=True)
    if output.is_symlink() or not output.is_dir():
        raise ValueError("output directory must be a regular directory")
    return output


def repository_path(value: str) -> str:
    if not value or value.startswith("/") or "\\" in value or "\0" in value:
        raise ValueError("repository path is not normalized")
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts) or utf8_size(value) > 4096:
        raise ValueError("repository path is not normalized")
    return value


def diagnostic(level: str, code: str, message: str) -> dict[str, str]:
    if level not in {"info", "warning", "error"} or not CODE_RE.fullmatch(code):
        raise ValueError("invalid diagnostic")
    encoded = message.encode("utf-8")[:MAX_DIAGNOSTIC_BYTES]
    while True:
        try:
            bounded = encoded.decode("utf-8")
            break
        except UnicodeDecodeError:
            encoded = encoded[:-1]
    return {"level": level, "code": code, "message": bounded or code}


def add_diagnostic(target: list[dict[str, str]], level: str, code: str, message: str) -> None:
    if len(target) < MAX_DIAGNOSTICS and not any(item["code"] == code for item in target):
        target.append(diagnostic(level, code, message))


def timings(installation_ms: int, restore_ms: int = 0, index_ms: int = 0, query_ms: int = 0) -> dict[str, int | None]:
    return {
        "installationMs": max(0, installation_ms),
        "restoreMs": max(0, restore_ms),
        "indexMs": max(0, index_ms),
        "queryMs": max(0, query_ms),
        "saveMs": None,
    }


def aggregate_status(files: list[dict[str, Any]]) -> str:
    statuses = {item["status"] for item in files}
    if not statuses or statuses == {"unsupported"}:
        return "unsupported"
    if statuses == {"complete"}:
        return "complete"
    if "complete" in statuses or "partial" in statuses or len(statuses) > 1:
        return "partial"
    if statuses == {"unavailable"}:
        return "unavailable"
    if statuses <= {"unsupported", "unavailable"}:
        return "unavailable"
    return "partial"


def make_artifact(
    repository: str,
    revision: str,
    status: str,
    files: list[dict[str, Any]],
    diagnostics: list[dict[str, str]],
    measured: dict[str, int | None],
) -> dict[str, Any]:
    return {
        "version": VERSION,
        "provider": {"id": PROVIDER_ID, "version": PROVIDER_VERSION},
        "repository": repository,
        "revision": revision,
        "status": status,
        "files": files,
        "diagnostics": diagnostics[:MAX_DIAGNOSTICS],
        "timings": measured,
    }


def serialized(artifact: dict[str, Any]) -> bytes:
    return (json.dumps(artifact, ensure_ascii=True, indent=2, sort_keys=False) + "\n").encode("utf-8")


def write_artifact(output: Path, artifact: dict[str, Any]) -> None:
    payload = serialized(artifact)
    if len(payload) > MAX_ARTIFACT_BYTES:
        for file_entry in reversed(artifact["files"]):
            if file_entry["related"]:
                file_entry["related"] = []
                if file_entry["status"] == "complete":
                    file_entry["status"] = "partial"
                artifact["status"] = aggregate_status(artifact["files"])
                payload = serialized(artifact)
                if len(payload) <= MAX_ARTIFACT_BYTES:
                    break
    if len(payload) > MAX_ARTIFACT_BYTES:
        raise ValueError("code-context artifact exceeds its byte limit")
    destination = output / "code-context.json"
    temporary = output / ".code-context.json.tmp"
    with temporary.open("wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, destination)


def initialize(args: argparse.Namespace) -> None:
    base, head, repository = validate_identity(args.base, args.head, args.repository)
    del base
    output = checked_output_directory(args.output_directory, args.workspace)
    status = args.status
    if status not in {"complete", "partial", "unsupported", "unavailable"}:
        raise ValueError("unsupported status")
    artifact = make_artifact(
        repository,
        head,
        status,
        [],
        [diagnostic("warning" if status != "unsupported" else "info", args.diagnostic_code, args.diagnostic_message)],
        timings(args.installation_ms),
    )
    write_artifact(output, artifact)


def git(repo: Path, arguments: list[str], *, capture: bool = True) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repo), *arguments],
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError("git command failed while preparing exact revision data")
    return result.stdout


def verify_revision(repo: Path, revision: str) -> str:
    resolved = git(repo, ["rev-parse", "--verify", f"{revision}^{{commit}}"], capture=True).decode("ascii").strip().lower()
    if resolved != revision:
        raise ValueError("requested revision does not match the resolved commit")
    return resolved


def export_source(repo: Path, head: str, source_root: Path) -> None:
    shutil.rmtree(source_root, ignore_errors=True)
    source_root.mkdir(parents=True, exist_ok=False)
    archive = subprocess.Popen(
        ["git", "-C", str(repo), "archive", head],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    assert archive.stdout is not None
    try:
        extract = subprocess.run(
            ["tar", "-x", "-C", str(source_root)],
            stdin=archive.stdout,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=120,
        )
        archive.stdout.close()
        archive_status = archive.wait(timeout=30)
    finally:
        if not archive.stdout.closed:
            archive.stdout.close()
        if archive.poll() is None:
            archive.kill()
            archive.wait()
    if archive_status != 0 or extract.returncode != 0:
        raise RuntimeError("could not export the requested head revision")

    for root, directories, names in os.walk(source_root, topdown=True, followlinks=False):
        root_path = Path(root)
        for name in list(directories) + names:
            candidate = root_path / name
            try:
                mode = candidate.lstat().st_mode
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(mode):
                candidate.unlink(missing_ok=True)
    shutil.rmtree(source_root / ".codegraphcontext", ignore_errors=True)
    (source_root / ".cgcignore").unlink(missing_ok=True)


def parse_changed_paths(
    repo: Path,
    base: str,
    head: str,
    diagnostics: list[dict[str, str]],
) -> tuple[list[tuple[str, str]], bool]:
    raw = git(repo, ["diff", "--name-status", "-z", "--find-renames", base, head])
    tokens = raw.split(b"\0")
    if tokens and tokens[-1] == b"":
        tokens.pop()
    changed: list[tuple[str, str]] = []
    index = 0
    while index < len(tokens):
        status_raw = tokens[index].decode("ascii")
        index += 1
        status = status_raw[0]
        if status in {"R", "C"}:
            if index + 1 >= len(tokens):
                raise ValueError("truncated rename or copy record")
            old_path = os.fsdecode(tokens[index])
            new_path = os.fsdecode(tokens[index + 1])
            index += 2
            selected = new_path
        else:
            if index >= len(tokens):
                raise ValueError("truncated changed-path record")
            old_path = new_path = os.fsdecode(tokens[index])
            index += 1
            selected = old_path if status == "D" else new_path
        try:
            changed.append((repository_path(selected), status))
        except ValueError:
            add_diagnostic(diagnostics, "warning", "changed-path-invalid", "A changed path was not a normalized repository path and was omitted.")

    changed.sort(key=lambda item: path_sort_key(item[0]))
    bounded: list[tuple[str, str]] = []
    path_bytes = 0
    truncated = False
    for item in changed:
        item_bytes = utf8_size(item[0])
        if len(bounded) >= MAX_CHANGED_FILES or path_bytes + item_bytes > MAX_CHANGED_PATH_BYTES:
            add_diagnostic(diagnostics, "warning", "changed-path-limit", "Changed paths exceeded the code-context file or byte limit; remaining paths were omitted.")
            truncated = True
            break
        bounded.append(item)
        path_bytes += item_bytes
    return bounded, truncated


def safe_source_file(source_root: Path, relative_path: str) -> Path | None:
    candidate = source_root / relative_path
    try:
        info = candidate.lstat()
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(source_root.resolve(strict=True))
    except (FileNotFoundError, OSError, ValueError):
        return None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        return None
    return resolved


def provider_environment(cgc_home: Path, cache_root: Path) -> dict[str, str]:
    database_file = cache_root / "database" / "falkordb.db"
    socket_file = cache_root / "database" / "falkordb.sock"
    return {
        "HOME": str(cgc_home),
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TMPDIR": os.environ.get("RUNNER_TEMP", "/tmp"),
        "CGC_RUNTIME_DB_TYPE": "falkordb",
        "CGC_RUNTIME_DB_PATH": str(database_file),
        "DEFAULT_DATABASE": "falkordb",
        "FALKORDB_PATH": str(database_file),
        "FALKORDB_SOCKET_PATH": str(socket_file),
        "CGC_IGNORE_PROJECT_ENV": "1",
        "ENABLE_AUTO_WATCH": "false",
        "SCIP_INDEXER": "false",
        "SKIP_EXTERNAL_RESOLUTION": "true",
        "INDEX_SOURCE": "false",
        "PARALLEL_WORKERS": "2",
        "IGNORE_TEST_FILES": "false",
    }


def parse_provider_json(raw: bytes) -> Any:
    text = raw.decode("utf-8")
    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character != "[":
            continue
        try:
            value, end = decoder.raw_decode(text, index)
        except json.JSONDecodeError:
            continue
        if isinstance(value, list) and text[end:].strip() == "":
            return value
    raise ValueError("provider output did not end with a JSON array")


def run_provider(
    executable: Path,
    arguments: list[str],
    environment: dict[str, str],
    timeout_seconds: int,
    *,
    json_output: bool = False,
) -> tuple[bool, Any | None]:
    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        try:
            result = subprocess.run(
                [str(executable), *arguments],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=stdout_file,
                stderr=stderr_file,
                env=environment,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired:
            return False, None
        if result.returncode != 0:
            return False, None
        if not json_output:
            return True, None
        size = stdout_file.seek(0, os.SEEK_END)
        if size > MAX_QUERY_OUTPUT_BYTES:
            return False, None
        stdout_file.seek(0)
        try:
            value = parse_provider_json(stdout_file.read())
        except (UnicodeDecodeError, ValueError):
            return False, None
        return True, value


def cypher_literal(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def validate_database(executable: Path, environment: dict[str, str], source_root: Path) -> bool:
    query = (
        f"MATCH (r:Repository {{path: {cypher_literal(str(source_root))}}}) "
        "RETURN count(r) AS repository_count LIMIT 1"
    )
    ok, value = run_provider(executable, ["query", query], environment, 30, json_output=True)
    return bool(
        ok
        and isinstance(value, list)
        and len(value) == 1
        and isinstance(value[0], dict)
        and value[0].get("repository_count") == 1
    )


def read_cache_state(path: Path) -> dict[str, Any] | None:
    try:
        if path.is_symlink() or path.stat().st_size > 4096:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def compatible_cache_state(
    value: dict[str, Any] | None,
    repository: str,
    configuration_id: str,
    source_root: Path,
) -> bool:
    if value is None or set(value) != {"version", "provider", "providerVersion", "repository", "revision", "configuration", "sourceRoot"}:
        return False
    revision = value.get("revision")
    return bool(
        value.get("version") == 1
        and value.get("provider") == PROVIDER_ID
        and value.get("providerVersion") == PROVIDER_VERSION
        and value.get("repository") == repository
        and isinstance(revision, str)
        and COMMIT_RE.fullmatch(revision)
        and value.get("configuration") == configuration_id
        and value.get("sourceRoot") == str(source_root)
    )


def database_has_material(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        return True
    return any(path.iterdir())


def database_tree_safe(path: Path) -> bool:
    try:
        root_info = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
        return False
    entries = 0
    for root, directories, names in os.walk(path, topdown=True, followlinks=False):
        root_path = Path(root)
        for name in directories:
            entries += 1
            try:
                mode = (root_path / name).lstat().st_mode
            except OSError:
                return False
            if entries > MAX_DATABASE_ENTRIES or stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                return False
        for name in names:
            entries += 1
            try:
                mode = (root_path / name).lstat().st_mode
            except OSError:
                return False
            if entries > MAX_DATABASE_ENTRIES or stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
                return False
    return True


def remove_path(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        path.unlink(missing_ok=True)
    else:
        shutil.rmtree(path)


def clear_database(cache_root: Path) -> None:
    cache_root.mkdir(parents=True, exist_ok=True)
    for entry in cache_root.iterdir():
        remove_path(entry)
    (cache_root / "database").mkdir(parents=True, exist_ok=True)


def write_cache_state(
    cache_root: Path,
    repository: str,
    revision: str,
    configuration_id: str,
    source_root: Path,
) -> None:
    state = {
        "version": 1,
        "provider": PROVIDER_ID,
        "providerVersion": PROVIDER_VERSION,
        "repository": repository,
        "revision": revision,
        "configuration": configuration_id,
        "sourceRoot": str(source_root),
    }
    temporary = cache_root / ".state.json.tmp"
    temporary.write_text(json.dumps(state, ensure_ascii=True, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, cache_root / "state.json")


def query_paths(paths: Iterable[str], source_root: Path) -> tuple[list[str], bool]:
    selected: list[str] = []
    used = 0
    for path in paths:
        absolute = str(source_root / path)
        literal_size = utf8_size(cypher_literal(absolute)) + 2
        if used + literal_size > MAX_QUERY_BYTES:
            return selected, True
        selected.append(absolute)
        used += literal_size
    return selected, False


def relationship_query(absolute_paths: list[str], direction: str) -> str:
    path_list = ", ".join(cypher_literal(path) for path in absolute_paths)
    if direction == "outgoing":
        match = "MATCH (changed)-[:CALLS|HEURISTIC_CALLS]->(related)"
    else:
        match = "MATCH (related)-[:CALLS|HEURISTIC_CALLS]->(changed)"
    return (
        f"{match} WHERE changed.path IN [{path_list}] "
        "AND related.path IS NOT NULL AND related.path <> changed.path "
        "RETURN changed.path AS changed_path, related.path AS related_path, "
        "related.line_number AS start_line, related.end_line AS end_line "
        f"LIMIT {QUERY_ROW_LIMIT}"
    )


def normalize_rows(
    value: Any,
    direction: str,
    source_root: Path,
    absolute_to_changed: dict[str, str],
) -> tuple[list[dict[str, Any]], bool]:
    if not isinstance(value, list):
        return [], True
    invalid = False
    rows: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict) or set(raw) != {"changed_path", "related_path", "start_line", "end_line"}:
            invalid = True
            continue
        changed_absolute = raw.get("changed_path")
        related_absolute = raw.get("related_path")
        start_line = raw.get("start_line")
        end_line = raw.get("end_line")
        if (
            not isinstance(changed_absolute, str)
            or changed_absolute not in absolute_to_changed
            or not isinstance(related_absolute, str)
            or not isinstance(start_line, int)
            or isinstance(start_line, bool)
            or start_line < 1
            or not (end_line is None or (isinstance(end_line, int) and not isinstance(end_line, bool) and end_line >= start_line))
        ):
            invalid = True
            continue
        try:
            related = Path(related_absolute).resolve(strict=True)
            related_path = repository_path(related.relative_to(source_root.resolve(strict=True)).as_posix())
        except (FileNotFoundError, OSError, ValueError):
            invalid = True
            continue
        if related_path == absolute_to_changed[changed_absolute]:
            continue
        rows.append(
            {
                "changedPath": absolute_to_changed[changed_absolute],
                "path": related_path,
                "startLine": start_line,
                "endLine": end_line if end_line is not None else start_line,
                "reason": (
                    "changed-code-calls-related-symbol"
                    if direction == "outgoing"
                    else "related-symbol-calls-changed-code"
                ),
            }
        )
    if len(value) >= QUERY_ROW_LIMIT:
        invalid = True
    return rows, invalid


def source_validated_contexts(
    rows: list[dict[str, Any]],
    source_root: Path,
    diagnostics: list[dict[str, str]],
) -> tuple[dict[str, list[dict[str, Any]]], bool]:
    unique: dict[tuple[Any, ...], dict[str, Any]] = {}
    for row in rows:
        key = (row["changedPath"], row["path"], row["startLine"], row["endLine"], row["reason"])
        unique[key] = row
    ordered = sorted(
        unique.values(),
        key=lambda row: (
            path_sort_key(row["changedPath"]),
            path_sort_key(row["path"]),
            row["startLine"],
            row["endLine"],
            path_sort_key(row["reason"]),
        ),
    )

    result: dict[str, list[dict[str, Any]]] = {}
    source_bytes = 0
    related_path_bytes = 0
    truncated = False
    for row in ordered:
        per_file = result.setdefault(row["changedPath"], [])
        if len(per_file) >= MAX_CONTEXTS_PER_FILE or sum(len(items) for items in result.values()) >= MAX_CONTEXTS:
            truncated = True
            continue
        candidate = safe_source_file(source_root, row["path"])
        if candidate is None:
            truncated = True
            continue
        try:
            if candidate.stat().st_size > MAX_SOURCE_FILE_BYTES:
                raise OSError("source file exceeds validation limit")
            content = candidate.read_bytes()
            text = content.decode("utf-8")
        except (OSError, UnicodeDecodeError):
            truncated = True
            continue
        lines = text.splitlines(keepends=True)
        if not lines or row["startLine"] > len(lines) or row["endLine"] > len(lines):
            truncated = True
            continue
        end_line = min(row["endLine"], row["startLine"] + MAX_CONTEXT_LINES - 1)
        remaining = MAX_CONTEXT_SOURCE_BYTES - source_bytes
        while end_line >= row["startLine"]:
            span_bytes = len("".join(lines[row["startLine"] - 1 : end_line]).encode("utf-8"))
            if span_bytes <= remaining:
                break
            end_line -= 1
        path_bytes = utf8_size(row["path"])
        if end_line < row["startLine"] or related_path_bytes + path_bytes > MAX_RELATED_PATH_BYTES:
            truncated = True
            continue
        per_file.append(
            {
                "path": row["path"],
                "startLine": row["startLine"],
                "endLine": end_line,
                "reason": row["reason"],
            }
        )
        source_bytes += span_bytes
        related_path_bytes += path_bytes
    if truncated:
        add_diagnostic(diagnostics, "warning", "context-selection-truncated", "Related context exceeded a source, line, path, or result limit; affected coverage is partial.")
    return result, truncated


def build_artifact(args: argparse.Namespace) -> bool:
    base, head, repository = validate_identity(args.base, args.head, args.repository)
    output = checked_output_directory(args.output_directory, args.workspace)
    workspace = Path(args.workspace).resolve(strict=True)
    repository_root = Path(git(workspace, ["rev-parse", "--show-toplevel"]).decode("utf-8").strip()).resolve(strict=True)
    verify_revision(repository_root, base)
    verify_revision(repository_root, head)

    diagnostics: list[dict[str, str]] = []
    measured = timings(args.installation_ms, args.restore_ms)
    source_root = Path(args.source_root).resolve(strict=False)
    cache_root = Path(args.cache_root).resolve(strict=False)
    cgc_home = Path(args.cgc_home).resolve(strict=False)
    executable = Path(args.executable).resolve(strict=True)
    if executable.is_symlink() or not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError("CGC executable is not a regular executable file")

    export_source(repository_root, head, source_root)
    changed, changed_paths_truncated = parse_changed_paths(repository_root, base, head, diagnostics)
    files: list[dict[str, Any]] = []
    supported_paths: list[str] = []
    for path, change_status in changed:
        source_file = safe_source_file(source_root, path)
        supported = (
            change_status != "D"
            and source_file is not None
            and Path(path).suffix.lower() in SUPPORTED_SUFFIXES
        )
        files.append({"changedPath": path, "status": "complete" if supported else "unsupported", "related": []})
        if supported:
            supported_paths.append(path)

    if changed_paths_truncated:
        for file_entry in files:
            if file_entry["status"] == "complete":
                file_entry["status"] = "partial"

    if not supported_paths:
        add_diagnostic(diagnostics, "info", "no-supported-changed-files", "No head-present changed file uses a language supported by the pinned CGC integration.")
        status = "partial" if changed_paths_truncated else aggregate_status(files)
        write_artifact(output, make_artifact(repository, head, status, files, diagnostics, measured))
        return False

    queryable_paths, query_path_truncated = query_paths(supported_paths, source_root)
    if query_path_truncated:
        add_diagnostic(diagnostics, "warning", "query-path-limit", "Changed source paths exceeded the provider-query byte limit; remaining supported files have partial coverage.")
        queryable = set(queryable_paths)
        for file_entry in files:
            absolute = str(source_root / file_entry["changedPath"])
            if file_entry["status"] == "complete" and absolute not in queryable:
                file_entry["status"] = "partial"

    cache_root.mkdir(parents=True, exist_ok=True)
    cgc_home.mkdir(parents=True, exist_ok=True)
    environment = provider_environment(cgc_home, cache_root)
    state_path = cache_root / "state.json"
    database_path = cache_root / "database"
    restored_material = bool(args.cache_matched_key) or database_has_material(database_path)
    cached_state = read_cache_state(state_path)

    query_started = monotonic_ms()
    cache_valid = (
        restored_material
        and database_tree_safe(database_path)
        and compatible_cache_state(cached_state, repository, args.configuration_id, source_root)
        and validate_database(executable, environment, source_root)
    )
    measured["queryMs"] = monotonic_ms() - query_started
    if args.cache_restore_outcome == "failure":
        add_diagnostic(diagnostics, "warning", "cache-restore-failed", "GitHub Actions cache restore failed; indexing continued without the restored database.")
    if restored_material and not cache_valid:
        add_diagnostic(diagnostics, "warning", "cache-restore-invalid", "The restored CGC database failed identity or query validation and was rebuilt once.")

    index_started = monotonic_ms()
    rebuilt = False
    if cache_valid:
        exact = cached_state is not None and cached_state.get("revision") == head
        add_diagnostic(
            diagnostics,
            "info",
            "cache-exact-head" if exact else "cache-compatible-head",
            "A validated exact-head CGC database was restored and refreshed." if exact else "A validated compatible CGC database was restored and re-indexed to the requested head.",
        )
        indexed, _ = run_provider(executable, ["update", str(source_root), "--quiet"], environment, 180)
        if not indexed:
            clear_database(cache_root)
            rebuilt = True
            indexed, _ = run_provider(executable, ["index", str(source_root), "--no-progress"], environment, 180)
    else:
        clear_database(cache_root)
        rebuilt = restored_material
        indexed, _ = run_provider(executable, ["index", str(source_root), "--no-progress"], environment, 180)
    measured["indexMs"] = monotonic_ms() - index_started

    if not indexed:
        for file_entry in files:
            if file_entry["status"] != "unsupported":
                file_entry["status"] = "unavailable"
        add_diagnostic(diagnostics, "error", "cgc-index-failed", "Pinned CGC could not index the exact head source; file-only review remains available.")
        write_artifact(output, make_artifact(repository, head, aggregate_status(files), files, diagnostics, measured))
        return False

    validation_started = monotonic_ms()
    database_valid = validate_database(executable, environment, source_root)
    measured["queryMs"] = int(measured["queryMs"] or 0) + monotonic_ms() - validation_started
    if not database_valid and not rebuilt:
        add_diagnostic(diagnostics, "warning", "cgc-post-index-invalid", "CGC validation failed after refresh; the database was rebuilt once.")
        clear_database(cache_root)
        rebuild_started = monotonic_ms()
        indexed, _ = run_provider(executable, ["index", str(source_root), "--no-progress"], environment, 180)
        measured["indexMs"] = int(measured["indexMs"] or 0) + monotonic_ms() - rebuild_started
        rebuilt = True
        validation_started = monotonic_ms()
        database_valid = indexed and validate_database(executable, environment, source_root)
        measured["queryMs"] = int(measured["queryMs"] or 0) + monotonic_ms() - validation_started

    if not database_valid:
        clear_database(cache_root)
        for file_entry in files:
            if file_entry["status"] != "unsupported":
                file_entry["status"] = "unavailable"
        add_diagnostic(diagnostics, "error", "cgc-validation-failed", "CGC could not answer the bounded database validation query after one rebuild.")
        write_artifact(output, make_artifact(repository, head, aggregate_status(files), files, diagnostics, measured))
        return False

    absolute_to_changed = {str(source_root / path): path for path in supported_paths if str(source_root / path) in queryable_paths}
    all_rows: list[dict[str, Any]] = []
    query_partial = query_path_truncated
    successful_queries = 0
    for direction in ("outgoing", "incoming"):
        query = relationship_query(queryable_paths, direction)
        query_started = monotonic_ms()
        ok, value = run_provider(executable, ["query", query], environment, 30, json_output=True)
        measured["queryMs"] = int(measured["queryMs"] or 0) + monotonic_ms() - query_started
        if not ok:
            query_partial = True
            add_diagnostic(diagnostics, "warning", f"cgc-{direction}-query-failed", f"CGC could not answer the bounded {direction} relationship query.")
            continue
        successful_queries += 1
        normalized, invalid = normalize_rows(value, direction, source_root, absolute_to_changed)
        all_rows.extend(normalized)
        query_partial = query_partial or invalid
    if successful_queries == 0:
        for file_entry in files:
            if file_entry["status"] != "unsupported":
                file_entry["status"] = "unavailable"
        write_artifact(output, make_artifact(repository, head, aggregate_status(files), files, diagnostics, measured))
        return False

    selected, selection_truncated = source_validated_contexts(all_rows, source_root, diagnostics)
    query_partial = query_partial or selection_truncated
    for file_entry in files:
        file_entry["related"] = selected.get(file_entry["changedPath"], [])
        if query_partial and file_entry["status"] == "complete":
            file_entry["status"] = "partial"
    if query_partial:
        add_diagnostic(diagnostics, "warning", "cgc-query-partial", "At least one provider row or query exceeded validation or a deterministic bound.")

    cache_ready = database_tree_safe(database_path)
    if cache_ready:
        write_cache_state(cache_root, repository, head, args.configuration_id, source_root)
    else:
        add_diagnostic(diagnostics, "warning", "cgc-cache-tree-invalid", "The validated query result is usable, but the database tree was unsafe to cache.")
        clear_database(cache_root)
    write_artifact(output, make_artifact(repository, head, aggregate_status(files), files, diagnostics, measured))
    return cache_ready


def build(args: argparse.Namespace) -> None:
    cache_ready = False
    try:
        cache_ready = build_artifact(args)
    except Exception:
        _, head, repository = validate_identity(args.base, args.head, args.repository)
        output = checked_output_directory(args.output_directory, args.workspace)
        artifact = make_artifact(
            repository,
            head,
            "unavailable",
            [],
            [diagnostic("error", "code-index-build-failed", "Code indexing failed before validated context could be exported; file-only review remains available.")],
            timings(args.installation_ms, args.restore_ms),
        )
        write_artifact(output, artifact)
    result_path = Path(args.result_file)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps({"cacheReady": cache_ready}) + "\n", encoding="utf-8")


def finalize(args: argparse.Namespace) -> None:
    artifact_path = Path(args.output_directory).resolve(strict=True) / "code-context.json"
    if artifact_path.is_symlink() or artifact_path.stat().st_size > MAX_ARTIFACT_BYTES:
        raise ValueError("code-context artifact is not a bounded regular file")
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    save_ms = None if args.save_ms == "null" else max(0, int(args.save_ms))
    artifact["timings"]["saveMs"] = save_ms
    artifact["diagnostics"] = [item for item in artifact["diagnostics"] if item.get("code") != "cache-save-failed"]
    if args.save_outcome == "failure":
        add_diagnostic(artifact["diagnostics"], "warning", "cache-save-failed", "GitHub Actions cache save failed; validated context remains available for this run.")
    write_artifact(artifact_path.parent, artifact)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)

    init = commands.add_parser("initialize")
    for name in ("base", "head", "repository", "output-directory", "workspace", "status", "diagnostic-code", "diagnostic-message"):
        init.add_argument(f"--{name}", required=True)
    init.add_argument("--installation-ms", type=int, required=True)

    build_command = commands.add_parser("build")
    for name in (
        "base", "head", "repository", "output-directory", "workspace", "source-root", "cache-root",
        "cgc-home", "executable", "configuration-id", "cache-matched-key", "cache-restore-outcome", "result-file",
    ):
        build_command.add_argument(f"--{name}", required=True)
    build_command.add_argument("--installation-ms", type=int, required=True)
    build_command.add_argument("--restore-ms", type=int, required=True)

    finish = commands.add_parser("finalize")
    finish.add_argument("--output-directory", required=True)
    finish.add_argument("--save-ms", required=True)
    finish.add_argument("--save-outcome", required=True)
    return root


def main() -> int:
    args = parser().parse_args()
    if args.command == "initialize":
        initialize(args)
    elif args.command == "build":
        build(args)
    else:
        finalize(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, RuntimeError) as error:
        print(f"redline code-index: {error}", file=sys.stderr)
        raise SystemExit(2) from error
