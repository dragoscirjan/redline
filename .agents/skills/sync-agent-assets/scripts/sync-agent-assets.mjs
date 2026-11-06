#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  CONFLICT: 3,
  PREREQUISITE: 4,
  COMMAND: 5,
  FILESYSTEM: 6,
});

const SCHEMA_VERSION = 1;
const MANAGER_VERSION = "1.1.0";
const DEFAULT_REPOSITORY = "https://github.com/dragoscirjan/ai.git";
const DEFAULT_REF = "main";
const LOCK_PATH = ".agents/ai-assets.lock.json";
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CATALOG = join(SKILL_ROOT, "assets", "skill-catalog.json");
const SOURCE_CATALOG = ".agents/skills/sync-agent-assets/assets/skill-catalog.json";
const CLAUDE_SKILLS_ROOT = ".claude/skills";
const SUPPORTED_HARNESSES = new Set(["pi", "opencode", "claude-code"]);
const TEMP_MARKER = ".sync-agent-assets-temp.json";
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".jj",
  ".svn",
  ".agents",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);
const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "VALIDATION.md",
  "CLAUDE.md",
  "CODEX.md",
  ".github/copilot-instructions.md",
];

class SyncError extends Error {
  constructor(message, exitCode = EXIT.CONFLICT) {
    super(message);
    this.name = "SyncError";
    this.exitCode = exitCode;
  }
}

const HELP = `Usage:
  node scripts/sync-agent-assets.mjs preflight
  node scripts/sync-agent-assets.mjs inspect --root PATH [--catalog PATH]
  node scripts/sync-agent-assets.mjs fetch [--repository URL] [--ref REF]
  node scripts/sync-agent-assets.mjs catalog [--source-root PATH]
  node scripts/sync-agent-assets.mjs status --root PATH
  node scripts/sync-agent-assets.mjs compare --root PATH --source-root PATH
  node scripts/sync-agent-assets.mjs record --root PATH --source-root PATH --source-commit SHA --selection FILE
  node scripts/sync-agent-assets.mjs record --root PATH --source-root PATH --source-commit SHA --selection FILE --apply --confirm --plan-id ID
  node scripts/sync-agent-assets.mjs cleanup --source-root PATH

The helper performs static inspection, fetches a pinned source checkout, compares
managed assets, and records synchronization state. It never edits project assets;
asset installation and instruction adaptation remain explicit, human-approved
steps in the sync-agent-assets workflow. The record command is plan-only unless
--apply --confirm --plan-id are supplied.

Options:
  --root PATH          Exact Git repository root
  --source-root PATH   Pinned dragoscirjan/ai checkout returned by fetch
  --source-commit SHA  Exact source commit to record
  --selection FILE     JSON selection and adaptation decisions
  --repository URL     Git source (default: ${DEFAULT_REPOSITORY})
  --ref REF            Branch, tag, or commit to fetch (default: ${DEFAULT_REF})
  --catalog PATH       Catalog override for inspection
  --apply              Write ${LOCK_PATH}; record only
  --confirm            Confirm the exact record plan was approved
  --plan-id ID         Plan ID emitted by record plan mode
  --format FORMAT      json or text (default: json)
  --help               Show this help

Prerequisites: Node.js 22.20 or newer and Git. The complete skill workflow also
requires Bun for the isolated-workspace helper.

Exit codes:
  0 success                  2 invalid arguments
  3 conflict or stale state  4 missing prerequisite
  5 external command failed  6 filesystem or unexpected failure`;

function requireNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 20)) {
    throw new SyncError("Node.js 22.20 or newer is required", EXIT.PREREQUISITE);
  }
}

function parseArgs(argv) {
  const options = { format: "json", apply: false, confirm: false, help: false };
  let commandName;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!commandName && !value.startsWith("-")) {
      commandName = value;
      continue;
    }
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }
    if (value === "--apply" || value === "--confirm") {
      options[value.slice(2)] = true;
      continue;
    }
    if (!value.startsWith("--")) {
      throw new SyncError(`Unexpected argument: ${value}`, EXIT.USAGE);
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new SyncError(`Missing value for --${name}`, EXIT.USAGE);
    }
    options[name] = next;
    index += 1;
  }
  return { command: commandName, options };
}

function emit(value, format = "json") {
  if (format === "text") {
    if (typeof value === "string") process.stdout.write(`${value}\n`);
    else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function run(cwd, commandName, args, { allowFailure = false } = {}) {
  const result = spawnSync(commandName, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error?.code === "ENOENT") {
    throw new SyncError(`${commandName} is required`, EXIT.PREREQUISITE);
  }
  if (result.error) {
    throw new SyncError(`${commandName} failed: ${result.error.message}`, EXIT.COMMAND);
  }
  if (!allowFailure && result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new SyncError(`${commandName} ${args.join(" ")} failed: ${detail}`, EXIT.COMMAND);
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function runGit(cwd, args, options) {
  return run(cwd, "git", ["-c", "core.fsmonitor=false", ...args], options);
}

function resolveDirectory(path, label) {
  if (!path) throw new SyncError(`${label} is required`, EXIT.USAGE);
  const resolved = realpathSync(resolve(path));
  if (!statSync(resolved).isDirectory()) {
    throw new SyncError(`${label} is not a directory: ${path}`, EXIT.USAGE);
  }
  return resolved;
}

function resolveGitRoot(path) {
  const root = resolveDirectory(path, "--root");
  const detected = realpathSync(runGit(root, ["rev-parse", "--show-toplevel"]).stdout.trim());
  if (detected !== root) {
    throw new SyncError(`--root must be the exact Git repository root: ${detected}`, EXIT.USAGE);
  }
  return root;
}

function safePath(root, path) {
  if (!path || isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
    throw new SyncError(`Unsafe relative path: ${path}`, EXIT.CONFLICT);
  }
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new SyncError(`Path escapes root: ${path}`, EXIT.CONFLICT);
  }
  return target;
}

function assertNoSymlinkComponents(root, target) {
  const relativePath = relative(root, target);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new SyncError(`Path escapes root: ${target}`, EXIT.CONFLICT);
  }
  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new SyncError(`Managed path component must not be a symbolic link: ${current}`, EXIT.CONFLICT);
    }
  }
}

function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SyncError(`Invalid JSON in ${label}: ${error.message}`, EXIT.CONFLICT);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileHash(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new SyncError(`Managed files must not be symbolic links: ${path}`, EXIT.CONFLICT);
  }
  if (!stat.isFile()) {
    throw new SyncError(`Managed path is not a file: ${path}`, EXIT.CONFLICT);
  }
  return sha256(readFileSync(path));
}

function walkFiles(root, { ignore = new Set(), maxFiles = 20000, rejectSymlinks = false } = {}) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) {
        if (rejectSymlinks) throw new SyncError(`Managed directories must not contain symbolic links: ${join(directory, entry.name)}`, EXIT.CONFLICT);
        continue;
      }
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) visit(absolute);
        continue;
      }
      if (entry.isFile()) files.push(rel);
      if (files.length > maxFiles) {
        throw new SyncError(`File inspection exceeds the ${maxFiles}-file safety limit`, EXIT.CONFLICT);
      }
    }
  }
  visit(root);
  return files;
}

function skillMap(catalog) {
  return new Map(catalog.skills.map((entry) => [entry.name, entry]));
}

function validateCatalog(catalog, sourceRoot) {
  if (!catalog || catalog.schemaVersion !== SCHEMA_VERSION || !Array.isArray(catalog.skills)) {
    throw new SyncError(`Catalog schemaVersion must be ${SCHEMA_VERSION}`, EXIT.CONFLICT);
  }
  if (typeof catalog.repository !== "string" || !catalog.repository) {
    throw new SyncError("Catalog repository must be a non-empty string", EXIT.CONFLICT);
  }
  for (const profile of ["manager", "bootstrap", "coreInstructions"]) {
    if (!Array.isArray(catalog.profiles?.[profile])) {
      throw new SyncError(`Catalog profile must be an array: ${profile}`, EXIT.CONFLICT);
    }
  }
  const names = new Set();
  for (const entry of catalog.skills) {
    if (!entry || typeof entry !== "object") throw new SyncError("Catalog skill entries must be objects");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name ?? "")) {
      throw new SyncError(`Invalid catalog skill name: ${entry.name}`);
    }
    if (names.has(entry.name)) throw new SyncError(`Duplicate catalog skill: ${entry.name}`);
    names.add(entry.name);
    if (!Array.isArray(entry.dependencies) || !Array.isArray(entry.harnesses)) {
      throw new SyncError(`Catalog dependencies and harnesses must be arrays: ${entry.name}`);
    }
    for (const harness of entry.harnesses) {
      if (!SUPPORTED_HARNESSES.has(harness)) {
        throw new SyncError(`Unsupported catalog harness for ${entry.name}: ${harness}`);
      }
    }
  }
  const byName = skillMap(catalog);
  for (const entry of catalog.skills) {
    for (const dependency of entry.dependencies) {
      if (!byName.has(dependency)) {
        throw new SyncError(`Unknown dependency ${dependency} for ${entry.name}`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(name) {
    if (visiting.has(name)) throw new SyncError(`Catalog dependency cycle at ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of byName.get(name).dependencies) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of names) visit(name);
  for (const [profile, members] of Object.entries(catalog.profiles ?? {})) {
    if (!Array.isArray(members)) throw new SyncError(`Catalog profile must be an array: ${profile}`);
    for (const name of members) if (!names.has(name)) throw new SyncError(`Unknown ${profile} profile skill: ${name}`);
  }
  if (sourceRoot) {
    const skillsRoot = safePath(sourceRoot, ".agents/skills");
    const directories = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort();
    const catalogNames = [...names].sort();
    if (canonicalJson(directories) !== canonicalJson(catalogNames)) {
      const missing = directories.filter((name) => !names.has(name));
      const stale = catalogNames.filter((name) => !directories.includes(name));
      throw new SyncError(`Catalog coverage mismatch; missing=[${missing.join(", ")}], stale=[${stale.join(", ")}]`);
    }
  }
  return catalog;
}

function loadCatalog(path = DEFAULT_CATALOG, sourceRoot) {
  return validateCatalog(readJson(path, "skill catalog"), sourceRoot);
}

function dependencyClosure(names, catalog) {
  const byName = skillMap(catalog);
  const result = new Set();
  function add(name) {
    const entry = byName.get(name);
    if (!entry) throw new SyncError(`Unknown selected skill: ${name}`);
    if (result.has(name)) return;
    for (const dependency of entry.dependencies) add(dependency);
    result.add(name);
  }
  for (const name of names) add(name);
  return [...result].sort();
}

function projectInventory(root) {
  const files = walkFiles(root, { ignore: IGNORED_DIRECTORIES });
  const paths = new Set(files);
  const basenames = new Set(files.map((file) => basename(file)));
  const extensionCounts = {};
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    if (extension) extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1;
  }
  return { files, paths, basenames, extensionCounts };
}

function signalReasons(entry, inventory) {
  const reasons = [];
  for (const file of entry.signals?.files ?? []) {
    if (inventory.paths.has(file) || inventory.basenames.has(file)) reasons.push(`file:${file}`);
  }
  for (const extension of entry.signals?.extensions ?? []) {
    const count = inventory.extensionCounts[extension.toLowerCase()] ?? 0;
    if (count > 0) reasons.push(`extension:${extension}(${count})`);
  }
  return reasons;
}

function installedSkills(root) {
  const skillsRoot = join(root, ".agents", "skills");
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

function claudeProjectionPath(name) {
  return `${CLAUDE_SKILLS_ROOT}/${name}`;
}

function claudeProjectionTarget(name) {
  return `../../.agents/skills/${name}`;
}

function expectedClaudeProjections(names) {
  return Object.fromEntries([...names].sort().map((name) => [claudeProjectionPath(name), {
    harness: "claude-code",
    skill: name,
    target: claudeProjectionTarget(name),
  }]));
}

function readLinkState(root, path, record) {
  const absolute = safePath(root, path);
  assertNoSymlinkComponents(root, dirname(absolute));
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return { path, ...record, state: "missing", actualTarget: null };
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    return { path, ...record, state: "conflict", actualTarget: stat.isDirectory() ? "directory" : "file" };
  }
  const actualTarget = readlinkSync(absolute).split(sep).join("/");
  const expectedAbsolute = safePath(root, `.agents/skills/${record.skill}`);
  const actualAbsolute = resolve(dirname(absolute), actualTarget);
  const state = actualTarget === record.target && actualAbsolute === expectedAbsolute ? "clean" : "conflict";
  return { path, ...record, state, actualTarget };
}

function projectionRecords(lock) {
  if (lock.projections && typeof lock.projections === "object" && !Array.isArray(lock.projections)) {
    return lock.projections;
  }
  return expectedClaudeProjections(lock.selection?.selectedSkills ?? []);
}

function projectionStatus(root, lock) {
  return Object.entries(projectionRecords(lock)).map(([path, record]) => readLinkState(root, path, record));
}

function readLock(root, { required = false } = {}) {
  const path = safePath(root, LOCK_PATH);
  assertNoSymlinkComponents(root, path);
  if (!existsSync(path)) {
    if (required) throw new SyncError(`Missing ${LOCK_PATH}; run initialization first`, EXIT.CONFLICT);
    return null;
  }
  const lock = readJson(path, LOCK_PATH);
  if (
    lock.schemaVersion !== SCHEMA_VERSION
    || typeof lock.files !== "object"
    || (lock.projections !== undefined && (typeof lock.projections !== "object" || Array.isArray(lock.projections)))
  ) {
    throw new SyncError(`Unsupported ${LOCK_PATH} schema`, EXIT.CONFLICT);
  }
  return lock;
}

function stateCounts(entries, states) {
  return Object.fromEntries(states.map((state) => [state, entries.filter((entry) => entry.state === state).length]));
}

function managedStatus(root, lock) {
  const files = [];
  for (const [path, record] of Object.entries(lock.files)) {
    const current = fileHash(safePath(root, path));
    const state = current === null ? "missing" : current === record.installedSha256 ? "clean" : "modified";
    files.push({ path, state, currentSha256: current, installedSha256: record.installedSha256 });
  }
  const projections = projectionStatus(root, lock);
  const states = ["clean", "modified", "missing", "conflict"];
  return {
    counts: stateCounts([...files, ...projections], states),
    fileCounts: stateCounts(files, states),
    projectionCounts: stateCounts(projections, states),
    files,
    projections,
  };
}

function preflightCommand(options) {
  const gitVersion = run(process.cwd(), "git", ["--version"]).stdout.trim();
  const bunVersion = run(process.cwd(), "bun", ["--version"]).stdout.trim();
  const npxVersion = run(process.cwd(), "npx", ["--version"]).stdout.trim();
  emit({
    skill: "sync-agent-assets",
    command: "preflight",
    node: process.versions.node,
    npx: npxVersion,
    git: gitVersion,
    bun: bunVersion,
    network: "verified by fetch",
  }, options.format);
}

function inspectCommand(options) {
  const root = resolveGitRoot(options.root);
  const catalogPath = options.catalog ? resolve(options.catalog) : DEFAULT_CATALOG;
  const catalog = loadCatalog(catalogPath);
  const inventory = projectInventory(root);
  const recommended = [];
  const ambiguous = [];
  const skipped = [];
  for (const entry of catalog.skills) {
    const reasons = signalReasons(entry, inventory);
    if (["manager", "bootstrap", "core"].includes(entry.selection)) {
      recommended.push({ name: entry.name, reason: entry.selection, dependencies: entry.dependencies });
    } else if (["detected", "wrapper"].includes(entry.selection) && reasons.length > 0) {
      recommended.push({ name: entry.name, reason: reasons.join(", "), dependencies: entry.dependencies });
    } else if (["optional", "initializer"].includes(entry.selection) && (reasons.length > 0 || entry.signals?.askWithoutSignals)) {
      ambiguous.push({ name: entry.name, reason: reasons.join(", ") || "optional", safety: entry.safety, dependencies: entry.dependencies });
    } else {
      skipped.push({ name: entry.name, reason: "no applicability signal" });
    }
  }
  const recommendedClosure = dependencyClosure(recommended.map((entry) => entry.name), catalog);
  const lock = readLock(root);
  emit({
    skill: "sync-agent-assets",
    command: "inspect",
    mode: lock ? "update" : "init",
    root,
    git: {
      branch: runGit(root, ["branch", "--show-current"]).stdout.trim() || null,
      head: runGit(root, ["rev-parse", "HEAD"]).stdout.trim(),
      status: runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout.split("\n").filter(Boolean),
    },
    instructions: INSTRUCTION_FILES.filter((path) => existsSync(safePath(root, path))),
    installedSkills: installedSkills(root),
    claudeProjections: Object.entries(expectedClaudeProjections(installedSkills(root)))
      .map(([path, record]) => readLinkState(root, path, record)),
    projectFacts: {
      inspectedFiles: inventory.files.length,
      manifests: inventory.files.filter((path) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|go\.work|composer\.json|Package\.swift|project\.godot|build\.zig|tsconfig\.json)$/.test(path)),
      extensionCounts: inventory.extensionCounts,
    },
    recommendedSkills: recommended,
    recommendedClosure,
    ambiguousSkills: ambiguous,
    skippedSkills: skipped,
    lock: lock ? { source: lock.source, selection: lock.selection, status: managedStatus(root, lock).counts } : null,
  }, options.format);
}

function assertSourceRef(ref) {
  if (!ref || ref.length > 255 || ref.startsWith("-") || /[\0\r\n]/.test(ref)) {
    throw new SyncError(`Unsafe Git ref: ${ref}`, EXIT.USAGE);
  }
  return ref;
}

function assertRepository(repository) {
  if (/^git@[^\s:]+:[^\s]+$/.test(repository)) return repository;
  try {
    const url = new URL(repository);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("unsafe URL components");
    }
    return url.toString();
  } catch {
    throw new SyncError("--repository must be a credential-free HTTPS or Git SSH URL", EXIT.USAGE);
  }
}

function fetchCommand(options) {
  const repository = assertRepository(options.repository ?? DEFAULT_REPOSITORY);
  const ref = assertSourceRef(options.ref ?? DEFAULT_REF);
  const tempRoot = mkdtempSync(join(tmpdir(), "sync-agent-assets-"));
  const sourceRoot = join(tempRoot, "source");
  try {
    writeFileSync(join(tempRoot, TEMP_MARKER), `${JSON.stringify({ schemaVersion: 1, owner: "sync-agent-assets", source: "source" })}\n`, { mode: 0o600 });
    mkdirSync(sourceRoot);
    runGit(sourceRoot, ["init", "-q"]);
    runGit(sourceRoot, ["remote", "add", "origin", repository]);
    runGit(sourceRoot, ["fetch", "--depth=1", "origin", ref]);
    runGit(sourceRoot, ["checkout", "--detach", "--quiet", "FETCH_HEAD"]);
    const commit = runGit(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
    loadCatalog(safePath(sourceRoot, SOURCE_CATALOG), sourceRoot);
    emit({ skill: "sync-agent-assets", command: "fetch", repository, ref, commit, sourceRoot, tempRoot }, options.format);
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function catalogCommand(options) {
  const sourceRoot = options["source-root"] ? resolveDirectory(options["source-root"], "--source-root") : null;
  const path = sourceRoot ? safePath(sourceRoot, SOURCE_CATALOG) : DEFAULT_CATALOG;
  const catalog = loadCatalog(path, sourceRoot);
  emit({
    skill: "sync-agent-assets",
    command: "catalog",
    schemaVersion: catalog.schemaVersion,
    profiles: catalog.profiles,
    skills: catalog.skills.map(({ name, category, selection, dependencies, safety, harnesses, requires = [], provenance = "local" }) => ({
      name,
      category,
      selection,
      dependencies,
      safety,
      harnesses,
      requires,
      provenance,
    })),
  }, options.format);
}

function statusCommand(options) {
  const root = resolveGitRoot(options.root);
  const lock = readLock(root, { required: true });
  emit({ skill: "sync-agent-assets", command: "status", root, source: lock.source, selection: lock.selection, ...managedStatus(root, lock) }, options.format);
}

function compareState(record, current, source) {
  const localChanged = current !== record.installedSha256;
  const sourceChanged = source !== record.sourceSha256;
  const recordedAdaptation = record.installedSha256 !== record.sourceSha256;
  if (current === null) return "missing";
  if (record.retained) {
    if (localChanged) return "local-modified";
    if (source === null) return "upstream-removed-retain";
    return "retained-no-update";
  }
  if (source === null) return "upstream-removed-retain";
  if (localChanged && sourceChanged) return "conflict";
  if (localChanged) return "local-modified";
  if (sourceChanged && record.kind === "instruction") return "adaptation-required";
  if (sourceChanged && recordedAdaptation) return "conflict";
  if (sourceChanged) return "upstream-changed-clean";
  return "unchanged";
}

function sourceCommit(sourceRoot) {
  return runGit(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
}

function assertCleanSourceCheckout(sourceRoot) {
  const status = runGit(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout.trim();
  if (status) {
    throw new SyncError("Pinned source checkout must be clean before comparison or recording", EXIT.CONFLICT);
  }
}

function compareCommand(options) {
  const root = resolveGitRoot(options.root);
  const sourceRoot = resolveDirectory(options["source-root"], "--source-root");
  const candidateCommit = sourceCommit(sourceRoot);
  assertCleanSourceCheckout(sourceRoot);
  const lock = readLock(root, { required: true });
  const catalog = loadCatalog(safePath(sourceRoot, SOURCE_CATALOG), sourceRoot);
  const files = [];
  for (const [path, record] of Object.entries(lock.files)) {
    const current = fileHash(safePath(root, path));
    const source = fileHash(safePath(sourceRoot, record.sourcePath));
    files.push({ path, kind: record.kind, skill: record.skill ?? null, state: compareState(record, current, source), currentSha256: current, sourceSha256: source });
  }
  const known = new Set(lock.catalogSkills ?? []);
  const currentNames = catalog.skills.map((entry) => entry.name);
  const projections = projectionStatus(root, lock);
  emit({
    skill: "sync-agent-assets",
    command: "compare",
    root,
    currentSource: lock.source,
    candidateSource: { repository: lock.source.repository, ref: lock.source.ref, commit: candidateCommit },
    counts: Object.fromEntries([...new Set(files.map((file) => file.state))].sort().map((state) => [state, files.filter((file) => file.state === state).length])),
    files,
    projectionCounts: stateCounts(projections, ["clean", "missing", "conflict"]),
    projections,
    newCatalogSkills: currentNames.filter((name) => !known.has(name)).sort(),
    removedCatalogSkills: [...known].filter((name) => !currentNames.includes(name)).sort(),
  }, options.format);
}

function normalizeSelection(selection, catalog) {
  if (!selection || !Array.isArray(selection.selectedSkills) || !Array.isArray(selection.rootFiles)) {
    throw new SyncError("Selection JSON requires selectedSkills and rootFiles arrays", EXIT.CONFLICT);
  }
  const byName = skillMap(catalog);
  const requiredProfileSkills = ["manager", "bootstrap", "coreInstructions"]
    .flatMap((profile) => catalog.profiles?.[profile] ?? []);
  const selectedSkills = dependencyClosure([...selection.selectedSkills, ...requiredProfileSkills], catalog);
  const rootFiles = [...new Set(selection.rootFiles)].sort();
  for (const path of rootFiles) safePath("/virtual-root", path);
  const declinedSkills = Array.isArray(selection.declinedSkills) ? selection.declinedSkills : [];
  const declinedNames = new Set();
  for (const decision of declinedSkills) {
    if (!decision || typeof decision.name !== "string" || typeof decision.reason !== "string") {
      throw new SyncError("declinedSkills entries require name and reason strings", EXIT.CONFLICT);
    }
    if (!byName.has(decision.name)) throw new SyncError(`Unknown declined skill: ${decision.name}`);
    if (selectedSkills.includes(decision.name)) throw new SyncError(`Skill cannot be selected and declined: ${decision.name}`);
    if (declinedNames.has(decision.name)) throw new SyncError(`Duplicate declined skill: ${decision.name}`);
    declinedNames.add(decision.name);
  }
  const adaptations = selection.adaptations && typeof selection.adaptations === "object" && !Array.isArray(selection.adaptations)
    ? selection.adaptations
    : {};
  for (const [path, note] of Object.entries(adaptations)) {
    if (!rootFiles.includes(path) || typeof note !== "string") {
      throw new SyncError(`Adaptation notes must be strings for managed root files: ${path}`);
    }
  }
  const retainedFiles = Array.isArray(selection.retainedFiles) ? selection.retainedFiles : [];
  const retainedPaths = new Set();
  for (const retained of retainedFiles) {
    if (!retained || typeof retained.path !== "string" || typeof retained.reason !== "string" || !retained.reason) {
      throw new SyncError("retainedFiles entries require path and non-empty reason strings", EXIT.CONFLICT);
    }
    safePath("/virtual-root", retained.path);
    if (retainedPaths.has(retained.path)) throw new SyncError(`Duplicate retained file: ${retained.path}`);
    retainedPaths.add(retained.path);
  }
  for (const requiredRoot of ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "VALIDATION.md"]) {
    if (!rootFiles.includes(requiredRoot) && !retainedPaths.has(requiredRoot)) {
      throw new SyncError(`Selection must manage or retain ${requiredRoot}`, EXIT.CONFLICT);
    }
  }
  return {
    selectedSkills,
    declinedSkills: declinedSkills.map(({ name, reason }) => ({ name, reason })).sort((a, b) => a.name.localeCompare(b.name)),
    rootFiles,
    adaptations,
    retainedFiles: retainedFiles.map(({ path, reason }) => ({ path, reason })).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function assertPortableSelection(selection, root, sourceRoot) {
  const serialized = JSON.stringify(selection);
  for (const path of [root, sourceRoot, realpathSync(tmpdir())]) {
    if (serialized.includes(path)) {
      throw new SyncError("Selection data must not contain absolute target, source, or temporary paths", EXIT.CONFLICT);
    }
  }
  if (/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----|\b(?:ghp_|github_pat_|sk-|AKIA)[A-Za-z0-9_\-]{12,}/.test(serialized)) {
    throw new SyncError("Selection data appears to contain credential material", EXIT.CONFLICT);
  }
}

function collectRecordFiles(root, sourceRoot, selection, previousLock) {
  const records = {};
  const retainedByPath = new Map(selection.retainedFiles.map((entry) => [entry.path, entry]));
  for (const name of selection.selectedSkills) {
    const sourceSkill = safePath(sourceRoot, `.agents/skills/${name}`);
    const targetSkill = safePath(root, `.agents/skills/${name}`);
    if (!existsSync(sourceSkill) || !existsSync(join(sourceSkill, "SKILL.md"))) {
      throw new SyncError(`Selected source skill is missing: ${name}`);
    }
    if (!existsSync(targetSkill) || !existsSync(join(targetSkill, "SKILL.md"))) {
      throw new SyncError(`Selected target skill is not installed: ${name}`);
    }
    const sourceFiles = walkFiles(sourceSkill, { rejectSymlinks: true });
    const targetFiles = walkFiles(targetSkill, { rejectSymlinks: true });
    const targetSet = new Set(targetFiles);
    const missing = sourceFiles.filter((path) => !targetSet.has(path));
    const unapprovedExtras = targetFiles.filter((path) => !sourceFiles.includes(path) && !retainedByPath.has(`.agents/skills/${name}/${path}`));
    if (missing.length > 0 || unapprovedExtras.length > 0) {
      throw new SyncError(`Target skill directory differs structurally from source: ${name}`);
    }
    for (const rel of sourceFiles) {
      const targetPath = `.agents/skills/${name}/${rel}`;
      const sourcePath = `.agents/skills/${name}/${rel}`;
      records[targetPath] = {
        kind: "skill",
        skill: name,
        sourcePath,
        sourceSha256: fileHash(safePath(sourceRoot, sourcePath)),
        installedSha256: fileHash(safePath(root, targetPath)),
      };
    }
  }
  for (const path of selection.rootFiles) {
    const source = safePath(sourceRoot, path);
    const target = safePath(root, path);
    if (!existsSync(source)) throw new SyncError(`Source instruction file is missing: ${path}`);
    if (!existsSync(target)) throw new SyncError(`Target instruction file is missing: ${path}`);
    records[path] = {
      kind: "instruction",
      sourcePath: path,
      sourceSha256: fileHash(source),
      installedSha256: fileHash(target),
    };
  }
  for (const retained of selection.retainedFiles) {
    if (!previousLock) throw new SyncError(`Cannot retain an unmanaged file: ${retained.path}`);
    const previous = previousLock.files[retained.path];
    if (!previous) throw new SyncError(`Retained file is absent from the previous lock: ${retained.path}`);
    if (records[retained.path]) throw new SyncError(`Retained file is still managed by the current selection: ${retained.path}`);
    const installedSha256 = fileHash(safePath(root, retained.path));
    if (!installedSha256) throw new SyncError(`Retained target file is missing: ${retained.path}`);
    records[retained.path] = {
      ...previous,
      installedSha256,
      retained: true,
      retentionReason: retained.reason,
      retainedFromCommit: previous.retainedFromCommit ?? previousLock.source.commit,
    };
  }
  return Object.fromEntries(Object.entries(records).sort(([left], [right]) => left.localeCompare(right)));
}

function collectRecordProjections(root, selection) {
  const records = expectedClaudeProjections(selection.selectedSkills);
  const states = Object.entries(records).map(([path, record]) => readLinkState(root, path, record));
  const invalid = states.filter((entry) => entry.state !== "clean");
  if (invalid.length > 0) {
    const details = invalid.map((entry) => `${entry.path}:${entry.state}`).join(", ");
    throw new SyncError(`Claude Code skill projections are not approved relative symlinks: ${details}`);
  }
  return records;
}

function recordPlan(options) {
  const root = resolveGitRoot(options.root);
  const sourceRoot = resolveDirectory(options["source-root"], "--source-root");
  const expectedCommit = options["source-commit"];
  if (!expectedCommit) throw new SyncError("--source-commit is required", EXIT.USAGE);
  const actualCommit = sourceCommit(sourceRoot);
  if (actualCommit !== expectedCommit) {
    throw new SyncError(`Source commit changed: expected ${expectedCommit}, found ${actualCommit}`, EXIT.CONFLICT);
  }
  assertCleanSourceCheckout(sourceRoot);
  if (!options.selection) throw new SyncError("--selection is required", EXIT.USAGE);
  const catalog = loadCatalog(safePath(sourceRoot, SOURCE_CATALOG), sourceRoot);
  const selection = normalizeSelection(readJson(resolve(options.selection), "selection file"), catalog);
  assertPortableSelection(selection, root, sourceRoot);
  const repository = assertRepository(options.repository ?? DEFAULT_REPOSITORY);
  const ref = assertSourceRef(options.ref ?? DEFAULT_REF);
  const remoteResult = runGit(sourceRoot, ["remote", "get-url", "origin"], { allowFailure: true });
  if (remoteResult.status === 0 && assertRepository(remoteResult.stdout.trim()) !== repository) {
    throw new SyncError("--repository does not match the pinned source checkout origin", EXIT.CONFLICT);
  }
  const lock = {
    $schema: "./skills/sync-agent-assets/assets/ai-assets-lock.schema.json",
    schemaVersion: SCHEMA_VERSION,
    managerVersion: MANAGER_VERSION,
    source: {
      repository,
      ref,
      commit: actualCommit,
    },
    selection,
    catalogSkills: catalog.skills.map((entry) => entry.name).sort(),
    files: collectRecordFiles(root, sourceRoot, selection, readLock(root)),
    projections: collectRecordProjections(root, selection),
  };
  return { root, sourceRoot, lock, planId: sha256(canonicalJson(lock)) };
}

function recordCommand(options) {
  const plan = recordPlan(options);
  if (options.apply) {
    if (!options.confirm || !options["plan-id"]) {
      throw new SyncError("record --apply requires --confirm and --plan-id", EXIT.USAGE);
    }
    if (options["plan-id"] !== plan.planId) {
      throw new SyncError("Record plan changed; generate and approve a new plan", EXIT.CONFLICT);
    }
    const lockPath = safePath(plan.root, LOCK_PATH);
    const lockDirectory = dirname(lockPath);
    assertNoSymlinkComponents(plan.root, lockDirectory);
    mkdirSync(lockDirectory, { recursive: true });
    assertNoSymlinkComponents(plan.root, lockDirectory);
    const temporary = `${lockPath}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, `${JSON.stringify(plan.lock, null, 2)}\n`, { mode: 0o644, flag: "wx" });
      renameSync(temporary, lockPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  emit({
    skill: "sync-agent-assets",
    command: "record",
    mode: options.apply ? "apply" : "plan",
    root: plan.root,
    sourceCommit: plan.lock.source.commit,
    planId: plan.planId,
    lockPath: LOCK_PATH,
    selectedSkills: plan.lock.selection.selectedSkills,
    declinedSkills: plan.lock.selection.declinedSkills,
    rootFiles: plan.lock.selection.rootFiles,
    retainedFiles: plan.lock.selection.retainedFiles,
    managedFileCount: Object.keys(plan.lock.files).length,
    managedProjectionCount: Object.keys(plan.lock.projections).length,
    lock: plan.lock,
  }, options.format);
}

function cleanupCommand(options) {
  const sourceRoot = resolveDirectory(options["source-root"], "--source-root");
  const parent = dirname(sourceRoot);
  const temporaryRoot = realpathSync(tmpdir());
  const resolvedParent = realpathSync(parent);
  const markerPath = join(resolvedParent, TEMP_MARKER);
  let marker = null;
  if (existsSync(markerPath)) marker = readJson(markerPath, TEMP_MARKER);
  if (
    basename(sourceRoot) !== "source"
    || dirname(resolvedParent) !== temporaryRoot
    || !basename(resolvedParent).startsWith("sync-agent-assets-")
    || marker?.schemaVersion !== 1
    || marker?.owner !== "sync-agent-assets"
    || marker?.source !== "source"
  ) {
    throw new SyncError(`Refusing to remove non-managed source directory: ${sourceRoot}`, EXIT.CONFLICT);
  }
  rmSync(resolvedParent, { recursive: true, force: true });
  emit({ skill: "sync-agent-assets", command: "cleanup", removed: resolvedParent }, options.format);
}

async function main() {
  requireNode();
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.help || !command) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (!['json', 'text'].includes(options.format)) {
    throw new SyncError("--format must be json or text", EXIT.USAGE);
  }
  switch (command) {
    case "preflight": preflightCommand(options); break;
    case "inspect": inspectCommand(options); break;
    case "fetch": fetchCommand(options); break;
    case "catalog": catalogCommand(options); break;
    case "status": statusCommand(options); break;
    case "compare": compareCommand(options); break;
    case "record": recordCommand(options); break;
    case "cleanup": cleanupCommand(options); break;
    default: throw new SyncError(`Unknown command: ${command}`, EXIT.USAGE);
  }
}

main().catch((error) => {
  const exitCode = error instanceof SyncError ? error.exitCode : EXIT.FILESYSTEM;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(exitCode);
});
