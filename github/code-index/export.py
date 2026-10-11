#!/usr/bin/env python3
"""Build Redline's bounded code-context artifact from a pinned code index."""

from __future__ import annotations

import argparse
import json
import os
import re
import resource
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable

VERSION = 1
PROVIDER_VERSIONS = {"cgc": "0.5.7", "gitnexus": "1.6.12"}
PROVIDER_ID = "cgc"
PROVIDER_VERSION = PROVIDER_VERSIONS[PROVIDER_ID]
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


def select_provider(provider: str, version: str) -> None:
    expected = PROVIDER_VERSIONS.get(provider)
    if expected is None or version != expected:
        raise ValueError("provider and version must select a pinned code-index integration")
    global PROVIDER_ID, PROVIDER_VERSION
    PROVIDER_ID = provider
    PROVIDER_VERSION = version


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
    shutil.rmtree(source_root / ".gitnexus", ignore_errors=True)
    (source_root / ".cgcignore").unlink(missing_ok=True)
    (source_root / ".gitnexusignore").unlink(missing_ok=True)
    (source_root / ".gitnexusrc").unlink(missing_ok=True)


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


def provider_environment(provider: str, provider_home: Path, cache_root: Path) -> dict[str, str]:
    environment = {
        "HOME": str(provider_home),
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TMPDIR": os.environ.get("RUNNER_TEMP", "/tmp"),
    }
    if provider == "gitnexus":
        environment.update({
            "GITNEXUS_HOME": str(provider_home),
            "GITNEXUS_STORAGE_PATH": str(cache_root / "database"),
            "GITNEXUS_EMBEDDING_MODE": "disabled",
        })
        return environment
    database_file = cache_root / "database" / "falkordb.db"
    socket_file = cache_root / "database" / "falkordb.sock"
    environment.update({
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
    })
    return environment


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


def limit_query_output() -> None:
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_QUERY_OUTPUT_BYTES, MAX_QUERY_OUTPUT_BYTES))


def run_provider(
    command: list[str],
    environment: dict[str, str],
    timeout_seconds: int,
    *,
    json_output: bool = False,
) -> tuple[bool, Any | None]:
    with tempfile.TemporaryFile() as stdout_file:
        try:
            result = subprocess.run(
                command,
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=stdout_file if json_output else subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=environment,
                timeout=timeout_seconds,
                preexec_fn=limit_query_output if json_output else None,
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


def provider_query_command(
    provider: str,
    executable: Path,
    runtime_executable: Path,
    query_adapter: Path,
    source_root: Path,
    query: str,
) -> list[str]:
    if provider == "cgc":
        return [str(executable), "query", query]
    module_root = executable.parents[2]
    return [str(runtime_executable), str(query_adapter), str(module_root), str(source_root), query]


def validate_database(
    provider: str,
    executable: Path,
    runtime_executable: Path,
    query_adapter: Path,
    environment: dict[str, str],
    source_root: Path,
) -> bool:
    if provider == "cgc":
        query = (
            f"MATCH (r:Repository {{path: {cypher_literal(str(source_root))}}}) "
            "RETURN count(r) AS repository_count LIMIT 1"
        )
        expected_key = "repository_count"
        expected_value = 1
    else:
        query = "MATCH (n) RETURN count(n) AS node_count LIMIT 1"
        expected_key = "node_count"
        expected_value = None
    ok, value = run_provider(
        provider_query_command(provider, executable, runtime_executable, query_adapter, source_root, query),
        environment,
        30,
        json_output=True,
    )
    if not (
        ok
        and isinstance(value, list)
        and len(value) == 1
        and isinstance(value[0], dict)
    ):
        return False
    result = value[0].get(expected_key)
    return result == expected_value if expected_value is not None else isinstance(result, int) and result > 0


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


def provider_cache_tree_safe(provider: str, cache_root: Path) -> bool:
    if not database_tree_safe(cache_root / "database"):
        return False
    return provider != "gitnexus" or database_tree_safe(cache_root / "gitnexus-home")


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


def prepare_cache(
    provider: str,
    cache_root: Path,
    repository: str,
    revision: str,
    configuration_id: str,
    source_root: Path,
    diagnostics: list[dict[str, str]],
) -> bool:
    if provider_cache_tree_safe(provider, cache_root):
        write_cache_state(cache_root, repository, revision, configuration_id, source_root)
        return True
    add_diagnostic(diagnostics, "warning", f"{provider}-cache-tree-invalid", "The validated database was unsafe to cache.")
    clear_database(cache_root)
    return False


def query_paths(provider: str, paths: Iterable[str], source_root: Path) -> tuple[list[str], bool]:
    selected: list[str] = []
    used = 0
    for path in paths:
        provider_path = str(source_root / path) if provider == "cgc" else path
        literal_size = utf8_size(cypher_literal(provider_path)) + 2
        if used + literal_size > MAX_QUERY_BYTES:
            return selected, True
        selected.append(provider_path)
        used += literal_size
    return selected, False


def relationship_query(provider: str, provider_paths: list[str], direction: str) -> str:
    path_list = ", ".join(cypher_literal(path) for path in provider_paths)
    if provider == "cgc":
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
    if direction == "outgoing":
        match = "MATCH (changed)-[r:CodeRelation]->(related)"
    else:
        match = "MATCH (related)-[r:CodeRelation]->(changed)"
    return (
        f"{match} WHERE changed.filePath IN [{path_list}] "
        "AND r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES'] "
        "AND related.filePath IS NOT NULL AND related.filePath <> changed.filePath "
        "AND related.startLine IS NOT NULL AND related.startLine >= 0 "
        "RETURN changed.filePath AS changed_path, related.filePath AS related_path, "
        "related.startLine + 1 AS start_line, related.endLine + 1 AS end_line "
        f"LIMIT {QUERY_ROW_LIMIT}"
    )


def normalize_rows(
    provider: str,
    value: Any,
    direction: str,
    source_root: Path,
    provider_to_changed: dict[str, str],
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
            or changed_absolute not in provider_to_changed
            or not isinstance(related_absolute, str)
            or not isinstance(start_line, int)
            or isinstance(start_line, bool)
            or start_line < 1
            or not (end_line is None or (isinstance(end_line, int) and not isinstance(end_line, bool) and end_line >= start_line))
        ):
            invalid = True
            continue
        try:
            if provider == "cgc":
                related = Path(related_absolute).resolve(strict=True)
                related_path = repository_path(related.relative_to(source_root.resolve(strict=True)).as_posix())
            else:
                related_path = repository_path(related_absolute)
        except (FileNotFoundError, OSError, ValueError):
            invalid = True
            continue
        if related_path == provider_to_changed[changed_absolute]:
            continue
        rows.append(
            {
                "changedPath": provider_to_changed[changed_absolute],
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
    head_source_root = Path(args.head_source_root).resolve(strict=False)
    cache_root = Path(args.cache_root).resolve(strict=False)
    provider = args.provider
    provider_home = Path(args.provider_home).resolve(strict=False)
    executable = Path(args.executable).resolve(strict=True)
    runtime_executable = Path(args.runtime_executable).resolve(strict=True)
    query_adapter = Path(args.query_adapter).resolve(strict=True)
    if executable.is_symlink() or not executable.is_file() or (provider == "cgc" and not os.access(executable, os.X_OK)):
        raise ValueError("provider executable is not a regular executable file")
    if runtime_executable.is_symlink() or not runtime_executable.is_file() or not os.access(runtime_executable, os.X_OK):
        raise ValueError("provider runtime is not a regular executable file")
    if query_adapter.is_symlink() or not query_adapter.is_file():
        raise ValueError("provider query adapter is not a regular file")

    export_source(repository_root, base, source_root)
    export_source(repository_root, head, head_source_root)
    provider_name = "CGC" if provider == "cgc" else "GitNexus"
    add_diagnostic(diagnostics, "info", "graph-base-revision", f"{provider_name} graph provenance is pull request base revision {base}.")
    changed, changed_paths_truncated = parse_changed_paths(repository_root, base, head, diagnostics)
    files: list[dict[str, Any]] = []
    supported_paths: list[str] = []
    missing_from_base = False
    for path, change_status in changed:
        head_source_file = safe_source_file(head_source_root, path)
        provider_supported = (
            change_status != "D"
            and head_source_file is not None
            and Path(path).suffix.lower() in SUPPORTED_SUFFIXES
        )
        base_source_file = safe_source_file(source_root, path) if provider_supported else None
        if provider_supported and base_source_file is not None:
            file_status = "complete"
            supported_paths.append(path)
        elif provider_supported:
            file_status = "partial"
            missing_from_base = True
        else:
            file_status = "unsupported"
        files.append({"changedPath": path, "status": file_status, "related": []})

    if missing_from_base:
        add_diagnostic(diagnostics, "warning", "changed-file-absent-from-base", "A supported changed file is absent from the base graph and cannot anchor a relationship query.")

    if changed_paths_truncated:
        for file_entry in files:
            if file_entry["status"] == "complete":
                file_entry["status"] = "partial"

    if not supported_paths:
        if any(file_entry["status"] == "partial" for file_entry in files):
            add_diagnostic(diagnostics, "warning", "no-base-query-anchors", "No supported changed file exists in the base graph; exact-head source review remains available.")
        else:
            add_diagnostic(diagnostics, "info", "no-supported-changed-files", f"No head-present changed file uses a language supported by the pinned {provider_name} integration; the base graph was still indexed for cache reuse.")

    queryable_paths, query_path_truncated = query_paths(provider, supported_paths, source_root)
    if query_path_truncated:
        add_diagnostic(diagnostics, "warning", "query-path-limit", "Changed source paths exceeded the provider-query byte limit; remaining supported files have partial coverage.")
        queryable = set(queryable_paths)
        for file_entry in files:
            provider_path = (
                str(source_root / file_entry["changedPath"])
                if provider == "cgc"
                else file_entry["changedPath"]
            )
            if file_entry["status"] == "complete" and provider_path not in queryable:
                file_entry["status"] = "partial"

    cache_root.mkdir(parents=True, exist_ok=True)
    provider_home.mkdir(parents=True, exist_ok=True)
    environment = provider_environment(provider, provider_home, cache_root)
    state_path = cache_root / "state.json"
    database_path = cache_root / "database"
    restored_material = bool(args.cache_matched_key) or database_has_material(database_path)
    cached_state = read_cache_state(state_path)

    query_started = monotonic_ms()
    cache_valid = (
        restored_material
        and provider_cache_tree_safe(provider, cache_root)
        and compatible_cache_state(cached_state, repository, args.configuration_id, source_root)
        and cached_state is not None
        and cached_state.get("revision") == base
        and validate_database(provider, executable, runtime_executable, query_adapter, environment, source_root)
    )
    measured["queryMs"] = monotonic_ms() - query_started
    if args.cache_restore_outcome == "failure":
        add_diagnostic(diagnostics, "warning", "cache-restore-failed", "GitHub Actions cache restore failed; indexing continued without the restored database.")
    if restored_material and not cache_valid:
        add_diagnostic(diagnostics, "warning", "cache-restore-invalid", f"The restored {provider_name} database failed identity or query validation and was rebuilt once.")

    cache_reused = cache_valid
    rebuilt = False
    if cache_reused:
        add_diagnostic(
            diagnostics,
            "info",
            "cache-base-revision",
            f"A validated pull request base {provider_name} database was restored and reused without indexing.",
        )
        indexed = True
        measured["indexMs"] = 0
    else:
        clear_database(cache_root)
        rebuilt = restored_material
        index_started = monotonic_ms()
        index_command = (
            [str(executable), "index", str(source_root), "--no-progress"]
            if provider == "cgc"
            else [str(runtime_executable), str(executable), "analyze", str(source_root), "--index-only", "--skip-git", "--skip-fts", "--workers", "2"]
        )
        indexed, _ = run_provider(index_command, environment, 180)
        measured["indexMs"] = monotonic_ms() - index_started

    if not indexed:
        for file_entry in files:
            if file_entry["status"] != "unsupported":
                file_entry["status"] = "unavailable"
        add_diagnostic(diagnostics, "error", f"{provider}-index-failed", f"Pinned {provider_name} could not index the pull request base source; file-only review remains available.")
        write_artifact(output, make_artifact(repository, head, aggregate_status(files), files, diagnostics, measured))
        return False

    database_valid = cache_reused
    if not cache_reused:
        validation_started = monotonic_ms()
        database_valid = validate_database(provider, executable, runtime_executable, query_adapter, environment, source_root)
        measured["queryMs"] = int(measured["queryMs"] or 0) + monotonic_ms() - validation_started
    if not database_valid and not rebuilt:
        add_diagnostic(diagnostics, "warning", f"{provider}-post-index-invalid", f"{provider_name} validation failed after indexing; the database was rebuilt once.")
        clear_database(cache_root)
        rebuild_started = monotonic_ms()
        indexed, _ = run_provider(index_command, environment, 180)
        measured["indexMs"] = int(measured["indexMs"] or 0) + monotonic_ms() - rebuild_started
        rebuilt = True
        validation_started = monotonic_ms()
        database_valid = indexed and validate_database(provider, executable, runtime_executable, query_adapter, environment, source_root)
        measured["queryMs"] = int(measured["queryMs"] or 0) + monotonic_ms() - validation_started

    if not database_valid:
        clear_database(cache_root)
        for file_entry in files:
            if file_entry["status"] != "unsupported":
                file_entry["status"] = "unavailable"
        add_diagnostic(diagnostics, "error", f"{provider}-validation-failed", f"{provider_name} could not answer the bounded database validation query after one rebuild.")
        write_artifact(output, make_artifact(repository, head, aggregate_status(files), files, diagnostics, measured))
        return False

    if not supported_paths:
        cache_ready = False if cache_reused else prepare_cache(provider, cache_root, repository, base, args.configuration_id, source_root, diagnostics)
        status = "partial" if changed_paths_truncated else aggregate_status(files)
        write_artifact(output, make_artifact(repository, head, status, files, diagnostics, measured))
        return cache_ready

    provider_to_changed = {
        (str(source_root / path) if provider == "cgc" else path): path
        for path in supported_paths
        if (str(source_root / path) if provider == "cgc" else path) in queryable_paths
    }
    all_rows: list[dict[str, Any]] = []
    query_partial = query_path_truncated
    successful_queries = 0
    for direction in ("outgoing", "incoming"):
        query = relationship_query(provider, queryable_paths, direction)
        query_started = monotonic_ms()
        ok, value = run_provider(
            provider_query_command(provider, executable, runtime_executable, query_adapter, source_root, query),
            environment,
            30,
            json_output=True,
        )
        measured["queryMs"] = int(measured["queryMs"] or 0) + monotonic_ms() - query_started
        if not ok:
            query_partial = True
            add_diagnostic(diagnostics, "warning", f"{provider}-{direction}-query-failed", f"{provider_name} could not answer the bounded {direction} relationship query.")
            continue
        successful_queries += 1
        normalized, invalid = normalize_rows(provider, value, direction, source_root, provider_to_changed)
        all_rows.extend(normalized)
        query_partial = query_partial or invalid
    if successful_queries == 0:
        for file_entry in files:
            if file_entry["status"] != "unsupported":
                file_entry["status"] = "unavailable"
        write_artifact(output, make_artifact(repository, head, aggregate_status(files), files, diagnostics, measured))
        return False

    selected, selection_truncated = source_validated_contexts(all_rows, head_source_root, diagnostics)
    query_partial = query_partial or selection_truncated
    for file_entry in files:
        file_entry["related"] = selected.get(file_entry["changedPath"], [])
        if query_partial and file_entry["status"] == "complete":
            file_entry["status"] = "partial"
    if query_partial:
        add_diagnostic(diagnostics, "warning", f"{provider}-query-partial", "At least one provider row or query exceeded validation or a deterministic bound.")

    cache_ready = False if cache_reused else prepare_cache(provider, cache_root, repository, base, args.configuration_id, source_root, diagnostics)
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
    for name in ("provider", "provider-version", "base", "head", "repository", "output-directory", "workspace", "status", "diagnostic-code", "diagnostic-message"):
        init.add_argument(f"--{name}", required=True)
    init.add_argument("--installation-ms", type=int, required=True)

    build_command = commands.add_parser("build")
    for name in (
        "provider", "provider-version", "base", "head", "repository", "output-directory", "workspace", "source-root", "head-source-root",
        "cache-root", "provider-home", "executable", "runtime-executable", "query-adapter", "configuration-id", "cache-matched-key", "cache-restore-outcome", "result-file",
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
    if args.command != "finalize":
        select_provider(args.provider, args.provider_version)
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
