import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCK_PATH = ".agents/ai-assets.lock.json";
export const HARNESSES = ["pi", "opencode", "claude-code"];
const SKILLS = ".agents/skills";
export const OWNER_CATALOG_PATH = ".agents/skills/agentic-work/sync-my-skills/assets/skill-catalog.yaml";
const MARKER = "sync-my-skills/stage-v2";
export const INSTRUCTION_FILES = Object.freeze(["AGENTS.md", "CONTRIBUTING.md", "DOCUMENTATION.md", "VALIDATION.md", "CLAUDE.md"]);
const INSTRUCTION_PREREQUISITES = ["isolated-workspace", "document-project", "asd-ste100-technical", "unslop"];
const SKIP = new Set([".git", "node_modules"]);
const PROJECT_SKIP = new Set([
  ...SKIP, ".agents", ".claude", ".pi", ".opencode", ".venv", "venv", "__pycache__",
  "dist", "build", "coverage", "vendor", ".next", ".godot",
]);
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FILES = 20000;

export class SyncError extends Error {
  constructor(message, exitCode = 3) { super(message); this.name = "SyncError"; this.exitCode = exitCode; }
}
function check(condition, message, code = 3) { if (!condition) throw new SyncError(message, code); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
export function digest(value) {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest("hex");
}
function equal(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function plain(value, depth = 0, seen = new Set()) {
  check(depth <= 40, "Configuration nesting is too deep");
  if (value === null || typeof value !== "object") return;
  check(!seen.has(value), "Configuration aliases/cycles are not supported");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    check(!["__proto__", "constructor", "prototype"].includes(key), "Unsafe configuration key");
    plain(child, depth + 1, seen);
  }
  seen.delete(value);
}
export function parseYaml(text, label = "YAML") {
  check(Buffer.byteLength(text) <= 1024 * 1024, `${label} exceeds the size limit`);
  const doc = parseDocument(text, { version: "1.2", strict: true, uniqueKeys: true, merge: false, customTags: [] });
  check(doc.errors.length === 0 && doc.warnings.length === 0, `Invalid ${label}: ${doc.errors[0]?.code ?? doc.warnings[0]?.code ?? "parse error"}`);
  let result;
  try { result = doc.toJS({ maxAliasCount: 0 }); } catch { throw new SyncError(`Aliases are not supported in ${label}`); }
  plain(result);
  return result;
}
function jsonFile(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new SyncError(`Cannot read JSON: ${basename(path)}`); }
  plain(value);
  return value;
}
export function safeRelative(path, allowDot = false) {
  check(typeof path === "string" && path.length > 0 && !isAbsolute(path) && !path.includes("\\") && !/[\0\r\n:]/.test(path), "Unsafe relative path");
  if (allowDot && path === ".") return path;
  check(path.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Unsafe relative path");
  return path;
}
function safePath(root, rel) { return join(root, safeRelative(rel)); }
function inside(root, path) { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); }
function noLinks(root, path) {
  check(inside(root, path), "Path escapes its root");
  let current = root;
  for (const part of ["", ...relative(root, path).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    try { check(!lstatSync(current).isSymbolicLink(), "Symlink traversal is not permitted"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function readBytes(root, rel) {
  const path = safePath(root, rel);
  noLinks(root, path);
  const before = lstatSync(path);
  check(before.isFile(), `Not a regular file: ${rel}`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    noLinks(root, path);
    const opened = fstatSync(fd); const current = lstatSync(path);
    check(opened.isFile() && current.isFile() && opened.dev === before.dev && opened.ino === before.ino
      && opened.dev === current.dev && opened.ino === current.ino, `File changed while opening: ${rel}`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function writeBytes(root, rel, value, mode = 0o644) {
  const path = safePath(root, rel);
  noLinks(root, path);
  mkdirSync(dirname(path), { recursive: true });
  noLinks(root, dirname(path));
  const temporary = join(dirname(path), `.sync-${randomUUID()}`);
  try { writeFileSync(temporary, value, { flag: "wx", mode }); chmodSync(temporary, mode); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}
function writeJson(root, rel, value) { writeBytes(root, rel, `${JSON.stringify(value, null, 2)}\n`); }
function runGit(root, args) {
  // Status refresh can run fsmonitor hooks and clean/process filters. Disable
  // those commands for helper reads, not for the owner's publication commands.
  const base = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${process.execPath}`, "-C", root];
  const options = { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30000 };
  const config = spawnSync("git", [...base, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], options);
  check([0, 1].includes(config.status), "Cannot inspect Git filter configuration", 4);
  const filters = new Set();
  for (const key of config.stdout.split("\0").filter(Boolean)) {
    check(/^filter\.[\w.-]+\.(?:clean|smudge|process|required)$/i.test(key), "Unsupported Git filter configuration; inspect it before continuing", 4);
    filters.add(key.slice(0, key.lastIndexOf(".")));
  }
  const overrides = [...filters].flatMap((name) => ["-c", `${name}.clean=`, "-c", `${name}.smudge=`, "-c", `${name}.process=`, "-c", `${name}.required=false`]);
  const result = spawnSync("git", [...base, ...overrides, ...args], options);
  check(result.status === 0, `Git command failed: ${args[0]}`, 4);
  return result.stdout.trim();
}
function gitRoot(path) {
  const root = resolve(path);
  check(existsSync(root), "Project directory does not exist", 4);
  noLinks(root, root);
  check(realpathSync(root) === realpathSync(runGit(root, ["rev-parse", "--show-toplevel"])), "Use the Git repository root", 4);
  return root;
}
function isolated(root) {
  const gitDir = runGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  check(realpathSync(gitDir) !== realpathSync(commonDir), "Apply requires an isolated Git worktree; never mutate the primary checkout", 4);
}
function walk(root, skip = SKIP, skipLinks = false) {
  const files = [];
  function visit(rel) {
    const dir = rel ? safePath(root, rel) : root;
    noLinks(root, dir);
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.has(entry.name)) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      safeRelative(path);
      if (entry.isSymbolicLink() && skipLinks) continue;
      check(!entry.isSymbolicLink(), `Symlink in content: ${path}`);
      if (entry.isDirectory()) visit(path);
      else { check(entry.isFile(), `Unsupported file type: ${path}`); files.push(path); }
      check(files.length <= MAX_FILES, "File inventory exceeds the safety limit");
    }
  }
  if (existsSync(root)) visit("");
  return files.sort();
}
function hashes(root) { return Object.fromEntries(walk(root).map((rel) => [rel, digest(readBytes(root, rel))])); }
function fileModes(root) { return Object.fromEntries(walk(root).map((rel) => [rel, lstatSync(safePath(root, rel)).mode & 0o111 ? 0o755 : 0o644])); }
function fingerprint(root) { return digest({ files: hashes(root), modes: fileModes(root) }); }
function matchesFile(state, hash, mode) { return state.type === "file" && state.sha256 === hash && (mode === undefined || state.mode === mode); }
function snapshot(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return { type: "missing" }; throw error; }
  if (stat.isSymbolicLink()) return { type: "link", target: readlinkSync(path) };
  if (stat.isFile()) return { type: "file", sha256: digest(readBytes(dirname(path), basename(path))), mode: stat.mode & 0o111 ? 0o755 : 0o644 };
  check(stat.isDirectory(), "Unsupported destination type");
  const entries = [];
  function visit(dir, prefix) {
    noLinks(path, dir);
    const before = lstatSync(dir);
    check(before.isDirectory(), "Removal directory changed");
    const children = readdirSync(dir, { withFileTypes: true });
    noLinks(path, dir);
    const current = lstatSync(dir);
    check(current.isDirectory() && current.dev === before.dev && current.ino === before.ino, "Removal directory changed");
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelative(rel);
      const child = join(dir, entry.name);
      const state = lstatSync(child);
      if (state.isSymbolicLink()) entries.push([rel, "link", readlinkSync(child)]);
      else if (state.isDirectory()) { entries.push([rel, "directory"]); visit(child, rel); }
      else { check(state.isFile(), "Unsupported removal content"); entries.push([rel, "file", digest(readBytes(path, rel)), state.mode & 0o111 ? 0o755 : 0o644]); }
      check(entries.length <= MAX_FILES, "Removal inventory exceeds the safety limit");
    }
  }
  visit(path, "");
  return { type: "directory", sha256: digest(entries), entries: entries.length };
}
function strings(value, label, { names = false } = {}) {
  check(Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0), `${label} must be a string array`);
  check(new Set(value).size === value.length, `Duplicate value in ${label}`);
  if (names) check(value.every((item) => item.length <= 64 && NAME.test(item)), `Invalid skill name in ${label}`);
  return value;
}
function knownKeys(value, keys, label) { check(Object.keys(value).every((key) => keys.includes(key)), `Unknown field in ${label}`); }
function github(repository) {
  let url;
  try { url = new URL(repository); } catch { throw new SyncError("Invalid GitHub repository URL"); }
  check(url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.search && !url.hash, "Use a credential-free HTTPS GitHub repository URL");
  const match = url.pathname.replace(/\.git$/, "").match(/^\/([\w.-]+)\/([\w.-]+)\/?$/);
  check(match, "Use a GitHub repository URL, not a tree/blob URL");
  return { owner: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}` };
}
function sourceDescriptor(source, external = false) {
  check(object(source), "Skill source must be an object");
  knownKeys(source, ["type", "path", "repository", "revision"], "source");
  check(["local", "github"].includes(source.type), "Unsupported source type");
  safeRelative(source.path, true);
  if (source.type === "github" || external) {
    check(source.type === "github", "Upstream provenance must use a GitHub source");
    github(source.repository);
    check(/^[a-f0-9]{40}$/.test(source.revision ?? ""), "Upstream revisions must be full immutable commit IDs");
  }
}
function installation(install, scope) {
  check(object(install), "Missing installation command");
  knownKeys(install, ["argv"], "install");
  const argv = install.argv;
  check(Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === "string" && arg.length > 0) && /^[\w.-]+$/.test(argv[0]), "Use an executable name and an argument array");
  check(!["sh", "bash", "zsh", "cmd", "powershell", "pwsh"].includes(argv[0]), "Shell programs are not installation recipes");
  check(argv.every((arg) => !/[\0\r\n]/.test(arg)), "Invalid installation argument");
  if (argv[0] === "npx") check(argv[1] === "-y", "Every npx command must put -y immediately after npx");
  if (scope !== "personal") check(!argv.some((arg) => arg === "--global" || arg.startsWith("--global=") || arg === "-g" || arg.startsWith("-g=") || arg === "--location=global"), "Project recipes must not install globally");
  portable(install);
}
function catalogOrigin(path, text, repository, ref) {
  const metadata = `${resolve(path)}.source.json`;
  if (!existsSync(metadata)) return null;
  noLinks(dirname(metadata), metadata);
  const record = jsonFile(metadata);
  check(object(record), "Invalid catalog snapshot metadata");
  knownKeys(record, ["schemaVersion", "repository", "ref", "revision", "path", "sha256"], "catalog snapshot");
  check(record.schemaVersion === 1 && github(record.repository).url.toLowerCase() === github(repository).url.toLowerCase() && record.ref === ref, "Catalog snapshot source does not match its definition");
  check(/^[a-f0-9]{40}$/.test(record.revision ?? "") && record.path === OWNER_CATALOG_PATH, "Invalid catalog snapshot revision/path");
  check(record.sha256 === digest(text), "Catalog snapshot content changed; refresh it instead of editing the snapshot");
  return { repository: record.repository, ref: record.ref, revision: record.revision, path: record.path, sha256: record.sha256 };
}
function localSkillPaths(root) {
  const found = new Map();
  let entries = 0;
  function visit(path, depth) {
    check(depth <= 40, "Skill inventory nesting is too deep");
    const folder = safePath(root, path);
    noLinks(root, folder);
    if (existsSync(join(folder, "SKILL.md"))) {
      const name = basename(folder);
      frontmatter(readBytes(root, `${path}/SKILL.md`).toString(), name);
      check(!found.has(name), `Duplicate local skill name: ${name}`);
      found.set(name, path);
      return;
    }
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name)) continue;
      check(++entries <= MAX_FILES, "Skill inventory exceeds the safety limit");
      const child = `${path}/${entry.name}`;
      safeRelative(child);
      check(!entry.isSymbolicLink(), `Symlink in skill inventory: ${child}`);
      if (entry.isDirectory()) visit(child, depth + 1);
    }
  }
  visit(SKILLS, 0);
  return found;
}
export function loadCatalog(path = join(PACKAGE_ROOT, "assets/skill-catalog.yaml"), sourceRoot) {
  const text = readFileSync(path, "utf8");
  const data = parseYaml(text, "skill catalog");
  check(object(data), "Catalog must be a mapping");
  knownKeys(data, ["schemaVersion", "repository", "ref", "defaults", "skills", "deprecations", "instructionTemplates"], "catalog");
  check(data.schemaVersion === 2, "Catalog schemaVersion must be 2");
  github(data.repository);
  check(typeof data.ref === "string" && /^[\w./-]+$/.test(data.ref) && !data.ref.startsWith("-") && !data.ref.includes(".."), "Invalid owner source ref");
  check(object(data.skills) && Object.keys(data.skills).length <= 1000, "Catalog skills must be a bounded mapping");
  check(object(data.defaults ?? {}), "Invalid catalog defaults");
  knownKeys(data.defaults ?? {}, ["exclude"], "defaults");
  strings(data.defaults?.exclude ?? [], "defaults.exclude").forEach((pattern) => safeRelative(pattern));
  const skills = Object.entries(data.skills).map(([name, definition]) => {
    check(name.length <= 64 && NAME.test(name) && object(definition), "Invalid catalog skill");
    knownKeys(definition, ["kind", "source", "upstream", "scope", "description", "category", "selection", "safety", "signals", "harnesses", "capabilities", "runtime", "prerequisites", "install", "include", "exclude", "legal", "adaptation"], name);
    check(["authored", "upstream", "adapted"].includes(definition.kind), `Invalid skill kind: ${name}`);
    sourceDescriptor(definition.source);
    if (definition.upstream) sourceDescriptor(definition.upstream, true);
    check(definition.kind !== "upstream" || definition.source.type === "github", `Upstream source required: ${name}`);
    check(definition.scope === undefined || ["personal", "project"].includes(definition.scope), "Invalid skill scope");
    check(name !== "sync-my-skills" || definition.scope === "personal", "The manager must remain personal tooling");
    check(name !== "sync-agent-assets", "The retired manager cannot be an active catalog entry");
    check(typeof definition.description === "string" && definition.description.length > 0, `Missing description: ${name}`);
    check(definition.selection === undefined || ["optional", "recommended", "detected", "wrapper", "initializer"].includes(definition.selection), `Invalid selection mode: ${name}`);
    for (const field of ["category", "safety"]) check(definition[field] === undefined || typeof definition[field] === "string", `Invalid ${field}: ${name}`);
    if (definition.signals !== undefined) {
      check(object(definition.signals), `Invalid signals: ${name}`);
      knownKeys(definition.signals, ["files", "extensions", "askWithoutSignals"], "signals");
      strings(definition.signals.files ?? [], "signals.files");
      strings(definition.signals.extensions ?? [], "signals.extensions");
      check(definition.signals.askWithoutSignals === undefined || typeof definition.signals.askWithoutSignals === "boolean", "Invalid legacy signal hint");
    }
    strings(definition.harnesses, `${name}.harnesses`);
    check(definition.harnesses.length > 0 && definition.harnesses.every((h) => HARNESSES.includes(h)), `Unsupported harness: ${name}`);
    const prerequisites = strings(definition.prerequisites ?? [], `${name}.prerequisites`, { names: true });
    strings(definition.capabilities ?? [], `${name}.capabilities`);
    strings(definition.runtime ?? [], `${name}.runtime`);
    installation(definition.install, definition.scope);
    for (const key of ["include", "exclude"]) strings(definition[key] ?? [], `${name}.${key}`).forEach((pattern) => safeRelative(pattern));
    check(Array.isArray(definition.legal ?? []), `Invalid legal files: ${name}`);
    for (const legal of definition.legal ?? []) {
      check(object(legal), "Invalid legal file"); knownKeys(legal, ["path", "target", "spdx"], "legal");
      safeRelative(legal.path); safeRelative(legal.target);
      check(typeof legal.spdx === "string" && legal.spdx.length > 0, "Missing legal license identifier");
    }
    if (definition.kind === "adapted") check(typeof definition.adaptation?.instructions === "string" && definition.adaptation.instructions.trim(), `Missing adaptation intent: ${name}`);
    if (definition.adaptation) {
      check(object(definition.adaptation) && typeof definition.adaptation.instructions === "string" && definition.adaptation.instructions.trim(), "Invalid adaptation intent");
      knownKeys(definition.adaptation, ["instructions", "review"], "adaptation");
      strings(definition.adaptation.review ?? [], `${name}.adaptation.review`);
    }
    if (sourceRoot && definition.source.type === "local") {
      const folder = safePath(sourceRoot, definition.source.path);
      noLinks(sourceRoot, folder);
      const meta = frontmatter(readBytes(folder, "SKILL.md").toString(), name);
      for (const requirement of meta.requires ?? []) check(prerequisites.includes(requirement), `Catalog is missing ${name}'s declared prerequisite ${requirement}`);
    }
    return { ...definition, name, scope: definition.scope ?? "project", prerequisites };
  });
  const byName = new Map(skills.map((entry) => [entry.name, entry]));
  for (const entry of skills) for (const name of entry.prerequisites) check(byName.has(name), `Unknown prerequisite ${name} for ${entry.name}`);
  const result = { ...data, skills, byName, hash: digest(data), path: resolve(path), catalogSource: catalogOrigin(path, text, data.repository, data.ref) };
  for (const entry of skills) closure([entry.name], result);
  check(data.deprecations === undefined || object(data.deprecations), "Deprecations must be a mapping");
  for (const [name, record] of Object.entries(data.deprecations ?? {})) {
    check(name.length <= 64 && NAME.test(name) && !byName.has(name) && object(record), `Invalid deprecation: ${name}`);
    knownKeys(record, ["replacements", "reason"], "deprecation");
    strings(record.replacements, `${name}.replacements`, { names: true });
    check(record.replacements.every((replacement) => byName.has(replacement)), `Unknown replacement: ${name}`);
    check(typeof record.reason === "string" && record.reason, `Missing deprecation reason: ${name}`);
  }
  if (data.instructionTemplates !== undefined) {
    const templates = data.instructionTemplates;
    check(object(templates), "Invalid instruction template configuration");
    knownKeys(templates, ["enabled", "issue", "path", "prerequisites"], "instructionTemplates");
    check(typeof templates.enabled === "boolean", "Instruction templates need an explicit enabled choice");
    check(templates.issue === undefined || (Number.isSafeInteger(templates.issue) && templates.issue > 0), "Invalid template issue reference");
    if (templates.enabled) {
      safeRelative(templates.path);
      strings(templates.prerequisites, "instruction template prerequisites", { names: true });
      check(equal([...templates.prerequisites].sort(), [...INSTRUCTION_PREREQUISITES].sort()), "Preserve the template's fixed instruction prerequisites");
      check(templates.prerequisites.every((name) => byName.get(name)?.scope === "project"), "Unknown instruction prerequisite");
    }
  }
  if (sourceRoot) {
    const directories = Object.fromEntries(localSkillPaths(sourceRoot));
    const local = Object.fromEntries(skills.filter((entry) => entry.source.type === "local").map((entry) => [entry.name, entry.source.path]));
    check(equal(directories, local), "Catalog coverage differs from local skill directories");
  }
  return result;
}
export function closure(names, catalog) {
  strings(names, "selectedSkills", { names: true });
  const visiting = new Set(); const done = new Set();
  function visit(name) {
    check(catalog.byName.has(name), `Unknown selected skill: ${name}`);
    check(!visiting.has(name), `Skill dependency cycle at ${name}`);
    if (done.has(name)) return;
    visiting.add(name);
    for (const dependency of catalog.byName.get(name).prerequisites) visit(dependency);
    visiting.delete(name); done.add(name);
  }
  names.forEach(visit);
  return [...done].sort();
}
function frontmatter(text, expectedName) {
  const match = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  check(match, `Missing skill frontmatter: ${expectedName}`);
  const meta = parseYaml(match[1], `frontmatter for ${expectedName}`);
  check(object(meta) && meta.name === expectedName && typeof meta.description === "string" && meta.description.trim() && meta.description.length <= 1024, `Invalid skill metadata: ${expectedName}`);
  if (meta.requires !== undefined) check(strings(meta.requires, "requires", { names: true }).length > 0, "Empty requires declaration");
  check(meta.require === undefined, "Obsolete require declaration");
  return meta;
}
function readLock(root) {
  const path = safePath(root, LOCK_PATH);
  noLinks(root, path);
  if (!existsSync(path)) return null;
  const lock = jsonFile(path);
  check([1, 2, 3].includes(lock.schemaVersion) && object(lock.files), "Unsupported or malformed skill lock");
  for (const field of ["skills", "selection", "projections", "legacyInstructions"]) check(lock[field] === undefined || object(lock[field]), `Invalid lock ${field} container`);
  check(lock.catalogSource === undefined || lock.catalogSource === null || object(lock.catalogSource), "Invalid lock catalog source");
  check(lock.instructions === undefined || lock.instructions === null || object(lock.instructions), "Invalid locked instruction bundle");
  for (const [path, record] of Object.entries(lock.files)) {
    safeRelative(path);
    check(object(record) && /^[a-f0-9]{64}$/.test(record.installedSha256 ?? ""), "Invalid locked file record");
    check(["skill", "instruction"].includes(record.kind), "Invalid locked file kind");
    if (record.kind === "instruction" && lock.schemaVersion === 3) check(INSTRUCTION_FILES.includes(path), "Invalid managed instruction path");
    check(record.mode === undefined || [0o644, 0o755].includes(record.mode), "Invalid locked file mode");
    check(record.kind === "instruction" || (NAME.test(record.skill ?? "") && path.startsWith(`${SKILLS}/${record.skill}/`)), "Invalid managed skill ownership/path");
    noLinks(root, dirname(safePath(root, path)));
  }
  for (const [path, record] of Object.entries(lock.projections ?? {})) {
    check(/^\.claude\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path) && object(record), "Invalid locked projection");
    check(record.skill === path.split("/").at(-1) && record.target === `../../.agents/skills/${record.skill}`, "Invalid projection target");
  }
  return lock;
}
function installed(root) {
  const found = new Map();
  for (const base of [SKILLS, ".claude/skills", ".opencode/skills", ".pi/skills"]) {
    const dir = safePath(root, base);
    noLinks(root, dir);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!NAME.test(entry.name)) continue;
      if (!entry.isSymbolicLink() && !(entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))) continue;
      const locations = found.get(entry.name) ?? [];
      const state = entry.isSymbolicLink() ? { type: "link", target: readlinkSync(join(dir, entry.name)) } : { type: "directory" };
      locations.push({ path: `${base}/${entry.name}`, state });
      found.set(entry.name, locations);
    }
  }
  return found;
}
function contextHash(root, requirements = "") {
  const paths = [...INSTRUCTION_FILES, "AGENTS.override.md", "README.md", "README.rst", "README.txt"];
  return digest({ files: Object.fromEntries(paths.map((path) => [path, snapshot(safePath(root, path))])), requirements });
}
function changedFiles(root, lock, name) {
  const records = Object.entries(lock?.files ?? {}).filter(([, record]) => record.skill === name);
  if (!records.length) return null;
  return records.filter(([path, record]) => !matchesFile(snapshot(safePath(root, path)), record.installedSha256, record.mode)).map(([path]) => path);
}
export function inspectProject({ root, catalog }) {
  root = gitRoot(root);
  const files = walk(root, PROJECT_SKIP, true);
  // CI metadata is useful context, not proof that the project's main purpose is coding.
  const signalFiles = files.filter((path) => !path.startsWith(".github/"));
  const names = new Set(signalFiles.map((path) => basename(path)));
  const extensions = {}; const signalExtensions = {};
  for (const path of files) { const ext = extname(path).toLowerCase(); if (ext) extensions[ext] = (extensions[ext] ?? 0) + 1; }
  for (const path of signalFiles) { const ext = extname(path).toLowerCase(); if (ext) signalExtensions[ext] = (signalExtensions[ext] ?? 0) + 1; }
  const found = installed(root); const lock = readLock(root);
  const recommended = []; const remaining = []; const personal = [];
  for (const entry of catalog.skills) {
    const reasons = [];
    for (const file of entry.signals?.files ?? []) if (names.has(file) || signalFiles.includes(file)) reasons.push(`file:${file}`);
    for (const ext of entry.signals?.extensions ?? []) if (signalExtensions[ext]) reasons.push(`extension:${ext}(${signalExtensions[ext]})`);
    if (Object.values(lock?.files ?? {}).some((record) => record.skill === entry.name)) reasons.push("previously managed");
    if (entry.selection === "recommended") reasons.push("catalog baseline recommendation");
    const item = { name: entry.name, description: entry.description, kind: entry.kind, reasons, installed: found.has(entry.name), prerequisites: entry.prerequisites, harnesses: entry.harnesses, runtime: entry.runtime ?? [], capabilities: entry.capabilities ?? [], install: entry.install };
    if (entry.scope === "personal") personal.push(item);
    else if (entry.selection === "recommended" || reasons.includes("previously managed") || (reasons.length && ["detected", "wrapper"].includes(entry.selection))) recommended.push(item);
    else remaining.push(item);
  }
  const deprecated = [...found].filter(([name]) => Object.hasOwn(catalog.deprecations ?? {}, name)).map(([name, locations]) => ({ name, ...catalog.deprecations[name], locations, changedFiles: changedFiles(root, lock, name) }));
  return {
    mode: lock ? "update" : "init", root,
    git: { branch: runGit(root, ["branch", "--show-current"]), head: runGit(root, ["rev-parse", "HEAD"]), statusNote: "Read-only raw-file hint; hooks, fsmonitor, and configured filters are disabled.", status: runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean) },
    projectFacts: { files: files.length, extensionCounts: extensions, signalExtensionCounts: signalExtensions, supportingMetadata: files.filter((path) => path.startsWith(".github/")), manifests: files.filter((path) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|project\.godot)$/.test(path)), documents: files.filter((path) => /(^|\/)(README[^/]*|AGENTS(?:\.override)?\.md|CONTRIBUTING\.md|DOCUMENTATION\.md|VALIDATION\.md|CLAUDE\.md)$/.test(path)) },
    instructions: INSTRUCTION_FILES.filter((path) => existsSync(safePath(root, path))),
    instructionBundle: { available: catalog.instructionTemplates?.enabled === true, files: INSTRUCTION_FILES.map((path) => ({ path, state: snapshot(safePath(root, path)) })), prerequisites: catalog.instructionTemplates?.enabled ? [...catalog.instructionTemplates.prerequisites] : [] },
    detectedHarnesses: HARNESSES.filter((h) => (h === "pi" && existsSync(join(root, ".pi"))) || (h === "opencode" && [".opencode", "opencode.json", "opencode.jsonc"].some((path) => existsSync(join(root, path)))) || (h === "claude-code" && existsSync(join(root, ".claude")))),
    recommendedSkills: recommended, remainingSkills: remaining, personalSkills: personal,
    installedSkills: [...found].map(([name, locations]) => ({ name, locations, catalogued: catalog.byName.has(name), deprecated: Object.hasOwn(catalog.deprecations ?? {}, name) })),
    deprecatedSkills: deprecated,
    previousDecisions: lock?.selection?.declinedSkills ?? [],
    contextHash: contextHash(root), catalogHash: catalog.hash,
    note: "Assess skills and instructions separately. Ask about every remaining active project skill, the selectable instruction bundle, harnesses, and exact removals. Existing target rules still govern the operation.",
  };
}
function glob(pattern, path) {
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") { expression += "(?:.*/)?"; i++; } else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`).test(path);
}
function excluded(catalog, entry, path) {
  return /(^|\/)agents\/openai\.ya?ml$/.test(path) || [...(catalog.defaults?.exclude ?? []), ...(entry.exclude ?? [])].some((pattern) => glob(pattern, path));
}
function recipe(catalog, entry) { return digest({ entry, exclude: catalog.defaults?.exclude ?? [] }); }
async function response(url, fetcher) {
  const result = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30000), headers: { Accept: "application/vnd.github+json" } });
  check(result.ok, `Source request failed (${result.status}): ${new URL(url).hostname}${new URL(url).pathname}`, 5);
  const bytes = Buffer.from(await result.arrayBuffer());
  check(bytes.length <= 32 * 1024 * 1024, "Source response exceeds the size limit");
  return bytes;
}
export async function refreshCatalog({ catalog = loadCatalog(), root, directory, fetcher = globalThis.fetch } = {}) {
  if (directory) check(!existsSync(resolve(directory)), "Use a fresh catalog snapshot directory");
  const protectedRoots = new Set([PACKAGE_ROOT, dirname(catalog.path), ...(root ? [gitRoot(root)] : [])]);
  for (const candidate of [process.cwd(), dirname(catalog.path)]) {
    try { protectedRoots.add(gitRoot(candidate)); } catch { /* An installed package need not be in Git. */ }
  }
  const destination = resolve(directory ?? tmpdir());
  const parent = directory ? dirname(destination) : destination;
  check(existsSync(parent), "Catalog temporary parent must already exist");
  const effective = directory ? join(realpathSync(parent), basename(destination)) : realpathSync(parent);
  for (const repository of protectedRoots) check(!inside(realpathSync(repository), effective), "Catalog snapshots must remain outside target and source repositories; select external temporary storage");
  const repo = github(catalog.repository);
  let revision = catalog.ref;
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    const commit = JSON.parse((await response(`https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(revision)}`, fetcher)).toString());
    check(/^[a-f0-9]{40}$/.test(commit.sha ?? ""), "Cannot resolve catalog revision");
    revision = commit.sha;
  }
  const bytes = await response(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${revision}/${OWNER_CATALOG_PATH}`, fetcher);
  check(bytes.length <= 1024 * 1024, "Catalog exceeds the size limit");
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new SyncError("Catalog is not valid UTF-8"); }
  if (directory) {
    directory = resolve(directory);
    check(!existsSync(directory), "Use a fresh catalog snapshot directory");
    noLinks(dirname(directory), dirname(directory));
    mkdirSync(directory);
  } else directory = mkdtempSync(join(tmpdir(), "sync-my-skills-catalog-"));
  try {
    writeBytes(directory, "skill-catalog.yaml", bytes);
    const path = join(directory, "skill-catalog.yaml");
    const candidate = loadCatalog(path);
    check(github(candidate.repository).url.toLowerCase() === repo.url.toLowerCase() && candidate.ref === catalog.ref, "Refreshed catalog changed its owner/ref; review a manager update instead");
    writeJson(directory, "skill-catalog.yaml.source.json", { schemaVersion: 1, repository: repo.url, ref: catalog.ref, revision, path: OWNER_CATALOG_PATH, sha256: digest(bytes) });
    const snapshot = loadCatalog(path);
    return { path, hash: snapshot.hash, source: snapshot.catalogSource };
  } catch (error) {
    // Only the fresh, manager-created download directory is removed on failure.
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
async function remoteTree(source, fetcher, cache) {
  const repo = github(source.repository);
  let revision = source.revision;
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    const data = JSON.parse((await response(`https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(revision)}`, fetcher)).toString());
    check(/^[a-f0-9]{40}$/.test(data.sha ?? ""), "Cannot resolve owner source revision"); revision = data.sha;
  }
  const key = `${repo.url}@${revision}`;
  if (!cache.has(key)) {
    const tree = JSON.parse((await response(`https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${revision}?recursive=1`, fetcher)).toString());
    check(Array.isArray(tree.tree) && !tree.truncated, "Incomplete GitHub source tree");
    cache.set(key, tree.tree);
  }
  return { repo, revision, tree: cache.get(key) };
}
async function acquire(entry, catalog, sourceRoot, fetcher, cache) {
  const result = new Map(); const modes = new Map();
  const local = entry.source.type === "local" && sourceRoot;
  let origin;
  let getFile; let getMode;
  let paths;
  if (local) {
    const folder = safePath(sourceRoot, entry.source.path);
    noLinks(sourceRoot, folder);
    paths = walk(folder);
    getMode = (path) => lstatSync(safePath(folder, path)).mode & 0o111 ? 0o755 : 0o644;
    getFile = async (path, legal = false) => readBytes(legal ? sourceRoot : folder, path);
    origin = { repository: catalog.repository, revision: runGit(sourceRoot, ["rev-parse", "HEAD"]), path: entry.source.path, dirty: Boolean(runGit(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"])) };
  } else {
    const source = entry.source.type === "github" ? entry.source : { type: "github", repository: catalog.repository, revision: catalog.catalogSource?.revision ?? catalog.ref, path: entry.source.path };
    const resolved = await remoteTree(source, fetcher, cache);
    const prefix = source.path === "." ? "" : `${source.path}/`;
    const blobs = resolved.tree.filter((item) => item.path.startsWith(prefix) && item.type === "blob");
    paths = blobs.map((item) => item.path.slice(prefix.length));
    const executable = new Set(blobs.filter((item) => item.mode === "100755").map((item) => item.path.slice(prefix.length)));
    getMode = (path) => executable.has(path) ? 0o755 : 0o644;
    for (const item of blobs) if (!excluded(catalog, entry, item.path.slice(prefix.length))) check(item.mode !== "120000", "Symlink in upstream content");
    getFile = async (path, legal = false) => {
      const rel = legal ? path : `${prefix}${path}`;
      safeRelative(rel);
      return response(`https://raw.githubusercontent.com/${resolved.repo.owner}/${resolved.repo.repo}/${resolved.revision}/${rel.split("/").map(encodeURIComponent).join("/")}`, fetcher);
    };
    origin = { repository: resolved.repo.url, revision: resolved.revision, path: source.path };
  }
  const selected = paths.filter((path) => !excluded(catalog, entry, path) && (!(entry.include?.length) || entry.include.some((pattern) => glob(pattern, path))));
  check(selected.length > 0 && selected.length <= 5000, `Invalid selected source size: ${entry.name}`);
  let total = 0;
  for (const path of selected.sort()) {
    safeRelative(path);
    const data = await getFile(path); total += data.length;
    check(total <= 64 * 1024 * 1024, `Skill source exceeds the size limit: ${entry.name}`);
    result.set(path, data); modes.set(path, getMode(path));
  }
  for (const legal of entry.legal ?? []) {
    const data = await getFile(legal.path, true);
    check(!result.has(legal.target) || result.get(legal.target).equals(data), `Conflicting legal file: ${entry.name}/${legal.target}`);
    result.set(legal.target, data); modes.set(legal.target, 0o644);
  }
  check(result.has("SKILL.md"), `Missing source SKILL.md: ${entry.name}`);
  const meta = frontmatter(result.get("SKILL.md").toString(), entry.name);
  for (const name of meta.requires ?? []) check(entry.prerequisites.includes(name), `Upstream prerequisite is not catalogued: ${entry.name} -> ${name}`);
  return { files: result, modes, origin };
}
function stageData(stage) {
  stage = resolve(stage);
  noLinks(stage, stage);
  const manifest = jsonFile(join(stage, "manifest.json"));
  check(manifest.marker === MARKER && object(manifest.skills), "Not a manager-owned stage");
  check(Object.keys(manifest.skills).every((name) => NAME.test(name)), "Invalid staged skill name");
  return manifest;
}
function instructionFiles(files, catalog) {
  strings(files, "instructionFiles");
  check(files.every((path) => INSTRUCTION_FILES.includes(path)), "Instruction scope is limited to the approved root bundle");
  if (files.length) {
    check(catalog.instructionTemplates?.enabled === true, "Instruction bundle is unavailable in this catalog");
    check(INSTRUCTION_FILES.slice(0, 4).every((path) => files.includes(path)), "Select the complete required instruction bundle");
  }
  return [...files].sort();
}
function instructionPrerequisites(root, selected, catalog) {
  const installed = {};
  for (const name of closure(catalog.instructionTemplates.prerequisites, catalog)) {
    if (selected.includes(name)) continue;
    const dir = safePath(root, `${SKILLS}/${name}`); noLinks(root, dir);
    check(existsSync(join(dir, "SKILL.md")), `Missing instruction prerequisite: ${name}; select it explicitly, resolve approved setup, or decline instruction changes`);
    const meta = frontmatter(readBytes(dir, "SKILL.md").toString(), name);
    check((meta.requires ?? []).every((requirement) => catalog.byName.get(name).prerequisites.includes(requirement)), `Review changed instruction prerequisite requirements: ${name}`);
    installed[name] = fingerprint(dir);
  }
  return installed;
}
async function prepareInstructions({ root, stage, files, catalog, selected, sourceRoot, fetcher, cache }) {
  const config = catalog.instructionTemplates;
  const names = ["README.md", ...files.map((path) => path.replace(".md", ".template.md"))];
  const sourceFiles = {}; let origin; let get;
  if (sourceRoot) {
    origin = { repository: catalog.repository, revision: runGit(sourceRoot, ["rev-parse", "HEAD"]), path: config.path, dirty: Boolean(runGit(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"])) };
    get = async (name) => readBytes(sourceRoot, `${config.path}/${name}`);
  } else {
    const source = await remoteTree({ repository: catalog.repository, revision: catalog.catalogSource?.revision ?? catalog.ref }, fetcher, cache);
    origin = { repository: source.repo.url, revision: source.revision, path: config.path };
    get = async (name) => {
      const path = `${config.path}/${name}`;
      check(source.tree.some((entry) => entry.path === path && entry.type === "blob" && ["100644", "100755"].includes(entry.mode)), `Missing or unsafe instruction template: ${name}`);
      return response(`https://raw.githubusercontent.com/${source.repo.owner}/${source.repo.repo}/${source.revision}/${path.split("/").map(encodeURIComponent).join("/")}`, fetcher);
    };
  }
  for (const name of names) {
    const bytes = await get(name); check(bytes.length <= 1024 * 1024, "Instruction template exceeds the size limit");
    writeBytes(stage, `templates/${name}`, bytes); sourceFiles[name] = digest(bytes);
  }
  for (const path of files) {
    const before = snapshot(safePath(root, path));
    check(["missing", "file"].includes(before.type), `Instruction destination conflict: ${path}`);
    const bytes = before.type === "file" ? readBytes(root, path) : readBytes(stage, `templates/${path.replace(".md", ".template.md")}`);
    writeBytes(stage, `instructions/${path}`, bytes);
  }
  return { origin, files, sourceFiles, recipeHash: digest(config), inputHash: fingerprint(join(stage, "templates")), prerequisites: instructionPrerequisites(root, selected, catalog), selectedPrerequisites: closure(config.prerequisites, catalog).filter((name) => selected.includes(name)) };
}
function instructionProse(text) {
  const lines = []; let fence;
  for (const line of text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const mark = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null; continue; }
    if (!fence) lines.push(line.replace(/^\s*[-*]\s+/, ""));
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}
function checkInstructionDraft(stage, record) {
  check(equal(hashes(join(stage, "templates")), record.sourceFiles) && fingerprint(join(stage, "templates")) === record.inputHash, "Instruction template source changed; prepare again");
  check(equal(walk(join(stage, "instructions")), [...record.files].sort()), "Instruction output scope differs from the prepared bundle");
  const projectNames = new Set();
  for (const path of record.files) {
    const bytes = readBytes(stage, `instructions/${path}`);
    check(bytes.length <= 1024 * 1024, `Instruction output exceeds the size limit: ${path}`);
    const text = bytes.toString();
    check(!/\{\{[A-Z][A-Z0-9_]*\}\}/.test(text), `Unresolved instruction field: ${path}`);
    check(!/(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)/.test(text), `Remove personal machine paths from ${path}`);
    portable({ text });
    const prose = instructionProse(text);
    const template = readBytes(stage, `templates/${path.replace(".md", ".template.md")}`).toString();
    const title = template.split(/\r?\n/).find((line) => line.includes("{{PROJECT_NAME}}"));
    if (title) {
      const [prefix, suffix] = title.split("{{PROJECT_NAME}}");
      const heading = text.split(/\r?\n/).find((line) => line.startsWith(prefix) && line.endsWith(suffix));
      const name = heading?.slice(prefix.length, suffix ? -suffix.length : undefined).trim();
      check(name, `Unresolved instruction project name in ${path}`); projectNames.add(name);
    }
    for (const line of template.split(/\r?\n/).filter((line) => line.trim() && !/^\s*#/.test(line) && !line.includes("{{"))) {
      check(prose.includes(instructionProse(line)), `Missing fixed template rule in ${path}`);
    }
  }
  check(projectNames.size === 1, "Use one consistent project name throughout the instruction bundle");
  return fingerprint(join(stage, "instructions"));
}
function instructionEvidence(root, extra = []) {
  strings(extra, "instruction evidence");
  const automatic = walk(root, PROJECT_SKIP, true).filter((path) => /(^|\/)(README[^/]*|AGENTS(?:\.override)?\.md|CLAUDE\.md|CONTRIBUTING\.md|DOCUMENTATION\.md|VALIDATION\.md|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|project\.godot|Makefile|justfile|Taskfile\.ya?ml|mkdocs\.ya?ml|(?:eslint|vite|vitest|playwright|next|nuxt|astro)\.config\.[\w.]+|tsconfig[^/]*\.json|\.gitignore)$/.test(path) || path.startsWith(".github/workflows/") || /(^|\/)\.vitepress\/config\./.test(path));
  const paths = [...new Set([...INSTRUCTION_FILES, "AGENTS.override.md", "README.md", ...automatic, ...extra])].sort();
  const result = {};
  for (const path of paths) {
    safeRelative(path);
    check(!["__proto__", "constructor", "prototype"].includes(path), "Unsafe instruction evidence key");
    check(!/(^|\/)(?:\.env(?!\.example$)(?:\.|$)|auth\.json$|credentials(?:\.|$)|id_(?:rsa|ed25519)(?:\.|$))|\.(?:pem|key)$/.test(path), "Do not read credential files as instruction evidence");
    noLinks(root, safePath(root, path)); const state = snapshot(safePath(root, path));
    check(["file", "missing"].includes(state.type), "Instruction evidence must name regular files or verified absences");
    result[path] = state;
  }
  return result;
}
function selectedInstructionGuidance(stage, record, manifest) {
  strings(record.selectedPrerequisites, "selected instruction prerequisites", { names: true });
  return Object.fromEntries(record.selectedPrerequisites.map((name) => {
    check(Object.hasOwn(manifest.skills, name), "Missing selected instruction guidance");
    return [name, fingerprint(join(stage, "skills", name))];
  }));
}
export function reviewInstructions({ stage, note, evidence = [] }) {
  const manifest = stageData(stage); check(manifest.instructions, "No instruction bundle in this stage");
  check(typeof note === "string" && note.trim(), "Record instruction facts, decisions, preserved rules, and review results");
  const outputHash = checkInstructionDraft(stage, manifest.instructions);
  const inputs = instructionEvidence(manifest.targetRoot, evidence);
  manifest.instructions.review = { note, evidence: inputs, extraEvidence: evidence, outputHash, selectedGuidance: selectedInstructionGuidance(stage, manifest.instructions, manifest) };
  writeJson(stage, "manifest.json", manifest);
  return { reviewed: true, files: manifest.instructions.files, outputHash };
}
export async function prepareSkills({ catalog, names, stage, sourceRoot, root, targetRequirements = "", instructionFiles: requestedInstructions = [], fetcher = globalThis.fetch, allowFetch = false }) {
  stage = resolve(stage);
  if (sourceRoot) sourceRoot = gitRoot(sourceRoot);
  if (root) root = gitRoot(root);
  check(!root || !inside(root, stage), "Stage must be outside the target repository");
  check(!sourceRoot || !inside(sourceRoot, stage), "Stage must be outside the source repository");
  let ancestor = dirname(stage); const suffix = [basename(stage)];
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(ancestor);
    check(parent !== ancestor, "Cannot resolve stage ancestor");
    suffix.unshift(basename(ancestor)); ancestor = parent;
  }
  const effectiveStage = join(realpathSync(ancestor), ...suffix);
  check(!root || !inside(realpathSync(root), effectiveStage), "Stage must be outside the target repository");
  check(!sourceRoot || !inside(realpathSync(sourceRoot), effectiveStage), "Stage must be outside the source repository");
  stage = effectiveStage;
  check(!existsSync(stage), "Use a fresh stage directory; existing content is never cleared");
  noLinks(dirname(stage), dirname(stage));
  const selected = closure(names, catalog);
  const requestedFiles = instructionFiles(requestedInstructions, catalog);
  if (requestedFiles.length) {
    check(root, "Instruction preparation requires a target root");
    instructionPrerequisites(root, selected, catalog);
    check(sourceRoot || allowFetch, "Instruction template fetch requires explicit --fetch permission", 4);
  }
  if (sourceRoot && (requestedFiles.length || selected.some((name) => catalog.byName.get(name).source.type === "local"))) {
    const remote = runGit(sourceRoot, ["remote", "get-url", "origin"]).replace(/^git@github\.com:/, "https://github.com/");
    check(github(remote).url.toLowerCase() === github(catalog.repository).url.toLowerCase(), "Local source origin does not match the catalog owner");
    if (catalog.catalogSource) check(runGit(sourceRoot, ["rev-parse", "HEAD"]) === catalog.catalogSource.revision && !runGit(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]), "Local source does not match the refreshed snapshot; use its clean revision or explicit bundled review mode");
  }
  for (const name of selected) {
    const entry = catalog.byName.get(name);
    check(entry.scope === "project", "The personal manager is not a project installation");
    check(allowFetch || (sourceRoot && entry.source.type === "local"), "Source fetch requires explicit --fetch permission", 4);
  }
  mkdirSync(stage, { recursive: true });
  const manifest = { marker: MARKER, catalogHash: catalog.hash, catalogSource: catalog.catalogSource, contextHash: root ? contextHash(root, targetRequirements) : digest(targetRequirements), targetRoot: root ?? null, targetRequirements, skills: {} };
  const previous = root ? readLock(root) : null;
  const cache = new Map();
  for (const name of selected) {
    const entry = catalog.byName.get(name);
    const acquired = await acquire(entry, catalog, sourceRoot, fetcher, cache);
    const sourceFiles = Object.fromEntries([...acquired.files].map(([path, bytes]) => [path, digest(bytes)]));
    for (const [path, bytes] of acquired.files) {
      writeBytes(stage, `raw/${name}/${path}`, bytes, acquired.modes.get(path));
      writeBytes(stage, `skills/${name}/${path}`, bytes, acquired.modes.get(path));
    }
    const record = { kind: entry.kind, origin: acquired.origin, upstream: entry.upstream ?? null, legal: entry.legal ?? [], recipeHash: recipe(catalog, entry), sourceFiles, sourceModes: Object.fromEntries(acquired.modes), inputHash: fingerprint(join(stage, "raw", name)) };
    const old = previous?.skills?.[name];
    if (root && old && old.inputHash === record.inputHash && old.recipeHash === record.recipeHash && old.contextHash === manifest.contextHash && equal(changedFiles(root, previous, name), [])) {
      const records = Object.entries(previous.files).filter(([, file]) => file.skill === name && !file.retained);
      if (records.length) {
        rmSync(join(stage, "skills", name), { recursive: true, force: true });
        for (const [path, file] of records) writeBytes(stage, `skills/${name}/${path.slice(`${SKILLS}/${name}/`.length)}`, readBytes(root, path), file.mode ?? 0o644);
        record.review = { note: old.review?.note ?? "Reused the unchanged approved result", outputHash: fingerprint(join(stage, "skills", name)) };
      }
    }
    manifest.skills[name] = record;
  }
  if (requestedFiles.length) manifest.instructions = await prepareInstructions({ root, stage, files: requestedFiles, catalog, selected, sourceRoot, fetcher, cache });
  writeJson(stage, "manifest.json", manifest);
  return { stage, skills: selected, instructionFiles: requestedFiles, needsReview: selected.filter((name) => catalog.byName.get(name).kind === "adapted" && !manifest.skills[name].review), instructionReviewRequired: requestedFiles.length > 0, note: "Review the external candidates. Nothing has been installed in the target." };
}
export function reviewSkill({ stage, name, note }) {
  const manifest = stageData(stage);
  check(Object.hasOwn(manifest.skills, name), "Skill is not in this stage");
  check(typeof note === "string" && note.trim(), "A substantive adaptation review note is required");
  check(fingerprint(join(stage, "raw", name)) === manifest.skills[name].inputHash, "Raw source changed during adaptation");
  manifest.skills[name].review = { note, outputHash: fingerprint(join(stage, "skills", name)) };
  writeJson(stage, "manifest.json", manifest);
  return { name, reviewed: true, outputHash: manifest.skills[name].review.outputHash };
}
function portable(value) {
  const text = JSON.stringify(value);
  check(!/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]{12,}/.test(text), "Do not record credential material");
  function visit(item) {
    if (typeof item === "string") check(!isAbsolute(item) && !/^[A-Za-z]:[\\/]/.test(item), "Do not record absolute machine paths");
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  }
  visit(value);
}
function normalizeSelection(selection, catalog) {
  plain(selection);
  check(object(selection), "Selection must be an object");
  knownKeys(selection, ["selectedSkills", "declinedSkills", "harnesses", "removeSkills", "resolutions", "targetRequirements", "rootFiles", "instructionFiles", "instructionApproval"], "selection");
  check(selection.rootFiles === undefined || (Array.isArray(selection.rootFiles) && selection.rootFiles.length === 0), "Legacy rootFiles does not authorize instruction adoption; use the reviewed instruction bundle");
  const roots = instructionFiles(selection.instructionFiles ?? [], catalog);
  check(typeof (selection.instructionApproval ?? "") === "string" && (!roots.length || (selection.instructionApproval ?? "").trim()), "Record explicit instruction-policy approval for the displayed changes");
  const selected = closure(selection.selectedSkills, catalog);
  const harnesses = strings(selection.harnesses, "harnesses");
  check(harnesses.length > 0 && harnesses.every((name) => HARNESSES.includes(name)), "Confirm at least one supported harness");
  for (const name of selected) {
    const entry = catalog.byName.get(name);
    check(entry.scope === "project", "Do not install the personal manager in a project");
    check(harnesses.every((h) => entry.harnesses.includes(h)), `Incompatible selected harness for ${name}`);
  }
  check(Array.isArray(selection.declinedSkills), "Explicit decisions for all remaining skills are required");
  const declined = new Set();
  for (const decision of selection.declinedSkills) {
    check(object(decision) && catalog.byName.get(decision.name)?.scope === "project" && typeof decision.reason === "string" && decision.reason.trim(), "Invalid declined skill decision");
    check(!selected.includes(decision.name) && !declined.has(decision.name), "Conflicting or duplicate skill decision");
    declined.add(decision.name);
  }
  const missing = catalog.skills.filter((entry) => entry.scope === "project" && !selected.includes(entry.name) && !declined.has(entry.name)).map((entry) => entry.name);
  check(missing.length === 0, `Ask about remaining catalog skills: ${missing.join(", ")}`);
  const removals = strings(selection.removeSkills ?? [], "removeSkills", { names: true });
  for (const name of removals) check(Object.hasOwn(catalog.deprecations ?? {}, name) && !selected.includes(name), `Removal is not a catalogued deprecation: ${name}`);
  check(object(selection.resolutions ?? {}), "resolutions must map exact paths to review notes");
  for (const [path, note] of Object.entries(selection.resolutions ?? {})) {
    safeRelative(path);
    check((roots.includes(path) || selected.some((name) => path.startsWith(`${SKILLS}/${name}/`) || path === `.claude/skills/${name}`)) && typeof note === "string" && note.trim(), "Invalid conflict resolution");
  }
  check(typeof (selection.targetRequirements ?? "") === "string", "targetRequirements must be text");
  const result = { selectedSkills: selected, declinedSkills: [...selection.declinedSkills].sort((a, b) => a.name.localeCompare(b.name)), harnesses: [...harnesses].sort(), removeSkills: [...removals].sort(), resolutions: selection.resolutions ?? {}, targetRequirements: selection.targetRequirements ?? "", instructionFiles: roots, instructionApproval: selection.instructionApproval ?? "" };
  portable(result);
  return result;
}
function actionPath(root, path, instructionFiles = []) {
  safeRelative(path);
  check((INSTRUCTION_FILES.includes(path) && instructionFiles.includes(path)) || path === LOCK_PATH || /^\.agents\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[^\0]+)?$/.test(path) || /^\.(?:claude|opencode|pi)\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path), "Action is outside the selected synchronization scope");
  const full = safePath(root, path);
  noLinks(root, dirname(full));
  return full;
}
export function planSync({ root, stage, selection, catalog }) {
  root = gitRoot(root); stage = resolve(stage);
  check(!inside(root, stage), "Stage must be outside the target");
  const manifest = stageData(stage);
  check(manifest.catalogHash === catalog.hash, "Catalog changed; prepare a new stage");
  check(equal(manifest.catalogSource ?? null, catalog.catalogSource ?? null), "Catalog snapshot changed; prepare a new stage with the pinned catalog");
  selection = normalizeSelection(selection, catalog);
  check(manifest.contextHash === contextHash(root, selection.targetRequirements), "Target requirements changed; prepare/review again");
  check(equal(Object.keys(manifest.skills).sort(), selection.selectedSkills), "Prepared skills differ from the approved selection closure");
  const previous = readLock(root);
  const files = {}; const skills = {}; const projections = {};
  const actions = [];
  let instructions = previous?.schemaVersion === 3 ? previous.instructions ?? null : null;
  check(equal(manifest.instructions?.files ?? [], selection.instructionFiles), "Prepared instruction scope differs from the selected bundle");
  if (selection.instructionFiles.length) {
    check(typeof manifest.targetRoot === "string" && existsSync(manifest.targetRoot) && realpathSync(manifest.targetRoot) === realpathSync(root), "Instruction stage belongs to another target; prepare for this worktree");
    const prepared = manifest.instructions;
    check(prepared.recipeHash === digest(catalog.instructionTemplates), "Instruction template recipe changed; prepare again");
    check(equal(prepared.prerequisites, instructionPrerequisites(root, selection.selectedSkills, catalog)), "Instruction prerequisite content changed; review again");
    check(equal(prepared.selectedPrerequisites, closure(catalog.instructionTemplates.prerequisites, catalog).filter((name) => selection.selectedSkills.includes(name))), "Selected instruction prerequisites changed; prepare again");
    check(equal(prepared.review?.selectedGuidance, selectedInstructionGuidance(stage, prepared, manifest)), "Instruction guidance changed; review the instruction bundle again");
    const outputHash = checkInstructionDraft(stage, prepared);
    check(prepared.review?.outputHash === outputHash && prepared.review.note?.trim(), "Instruction output review required");
    check(equal(prepared.review.evidence, instructionEvidence(root, prepared.review.extraEvidence)), "Instruction evidence changed; inspect, grill, and review again");
    for (const path of selection.instructionFiles) {
      const hash = digest(readBytes(stage, `instructions/${path}`)); const before = snapshot(actionPath(root, path, selection.instructionFiles));
      check(["missing", "file"].includes(before.type), `Instruction destination conflict: ${path}`);
      const old = previous?.schemaVersion === 3 ? previous.files[path] : null;
      if (before.type === "file" && !matchesFile(before, hash, 0o644) && (!old || !matchesFile(before, old.installedSha256, old.mode))) check(selection.resolutions[path], `Local/unmanaged instruction needs an exact resolution: ${path}`);
      const sourcePath = path.replace(".md", ".template.md");
      files[path] = { kind: "instruction", origin: prepared.origin, sourcePath, sourceSha256: prepared.sourceFiles[sourcePath], installedSha256: hash, mode: 0o644 };
      if (!matchesFile(before, hash, 0o644)) actions.push({ op: "write", path, from: `instructions/${path}`, before, sha256: hash, mode: 0o644, resolution: selection.resolutions[path] ?? null });
    }
    instructions = { ...prepared, contextHash: manifest.contextHash, outputHash };
  }
  const existing = installed(root);
  for (const name of selection.selectedSkills) {
    const entry = catalog.byName.get(name); const prepared = manifest.skills[name];
    check(prepared.recipeHash === recipe(catalog, entry), `Adaptation recipe changed: ${name}`);
    check(equal(hashes(join(stage, "raw", name)), prepared.sourceFiles) && equal(fileModes(join(stage, "raw", name)), prepared.sourceModes) && fingerprint(join(stage, "raw", name)) === prepared.inputHash, `Raw source changed: ${name}`);
    const outputs = hashes(join(stage, "skills", name));
    const outputModes = fileModes(join(stage, "skills", name));
    const outputMeta = frontmatter(readBytes(stage, `skills/${name}/SKILL.md`).toString(), name);
    for (const requirement of outputMeta.requires ?? []) check(selection.selectedSkills.includes(requirement), `Missing prepared prerequisite ${requirement} for ${name}`);
    for (const rel of Object.keys(outputs)) check(!excluded(catalog, entry, rel), `Forbidden/excluded output: ${name}/${rel}`);
    const legalPaths = new Set((entry.legal ?? []).map((item) => item.target));
    for (const rel of Object.keys(prepared.sourceFiles)) if (/(^|\/)(?:licen[sc]e(?:[.-].*)?|notice(?:[.-].*)?|copying(?:[.-].*)?|third[_-]party[_-]notices(?:[.-].*)?|[^/]*[-_]ofl(?:\.[^/]*)?)$/i.test(rel)) legalPaths.add(rel);
    for (const rel of legalPaths) check(outputs[rel] === prepared.sourceFiles[rel], `Legal notice changed or missing: ${name}/${rel}`);
    const outputHash = fingerprint(join(stage, "skills", name));
    if (entry.kind === "adapted" || outputHash !== prepared.inputHash) check(prepared.review?.outputHash === outputHash && prepared.review.note?.trim(), `Adaptation review required: ${name}`);
    skills[name] = { ...prepared, contextHash: manifest.contextHash, outputHash };
    for (const [rel, hash] of Object.entries(outputs)) {
      const path = `${SKILLS}/${name}/${rel}`; const full = actionPath(root, path); const before = snapshot(full);
      check(["missing", "file"].includes(before.type), `Destination conflict: ${path}`);
      const old = previous?.files?.[path];
      if (before.type === "file" && !matchesFile(before, hash, outputModes[rel]) && (!old || !matchesFile(before, old.installedSha256, old.mode))) check(selection.resolutions[path], `Local/unmanaged change requires an exact resolution: ${path}`);
      files[path] = { kind: "skill", skill: name, sourcePath: rel, sourceSha256: prepared.sourceFiles[rel] ?? null, installedSha256: hash, mode: outputModes[rel] };
      if (!matchesFile(before, hash, outputModes[rel])) actions.push({ op: "write", path, before, sha256: hash, mode: outputModes[rel], from: `skills/${name}/${rel}`, resolution: selection.resolutions[path] ?? null });
    }
    const installedFolder = safePath(root, `${SKILLS}/${name}`);
    for (const rel of walk(installedFolder)) {
      if (/(^|\/)agents\/openai\.ya?ml$/.test(rel)) {
        const path = `${SKILLS}/${name}/${rel}`;
        actions.push({ op: "remove-file", path, before: snapshot(actionPath(root, path)), reason: "Excluded OpenAI metadata" });
      }
    }
    if (selection.harnesses.includes("claude-code")) {
      const path = `.claude/skills/${name}`; const full = actionPath(root, path);
      const before = snapshot(full); const target = `../../.agents/skills/${name}`;
      if (before.type !== "missing" && !(before.type === "link" && before.target === target)) check(selection.resolutions[path], `Projection conflict requires an exact resolution: ${path}`);
      projections[path] = { harness: "claude-code", skill: name, target };
      if (!(before.type === "link" && before.target === target)) actions.push({ op: "link", path, before, target, resolution: selection.resolutions[path] ?? null });
    }
  }
  for (const [path, record] of Object.entries(previous?.files ?? {})) {
    if (record.kind === "instruction") {
      if (previous.schemaVersion === 3 && !files[path]) files[path] = { ...record, retained: true };
      continue;
    }
    if (!path.startsWith(`${SKILLS}/`) || selection.removeSkills.includes(record.skill)) continue;
    if (files[path] || actions.some((action) => action.path === path)) continue;
    if (!selection.selectedSkills.includes(record.skill)) { files[path] = { ...record, retained: true }; continue; }
    const before = snapshot(actionPath(root, path));
    if (before.type === "missing") continue;
    check(matchesFile(before, record.installedSha256, record.mode) || selection.resolutions[path], `Upstream removal conflicts with local content: ${path}`);
    actions.push({ op: "remove-file", path, before, resolution: selection.resolutions[path] ?? null });
  }
  for (const name of selection.removeSkills) {
    check(existing.has(name), `Deprecated skill is not installed: ${name}`);
    for (const location of existing.get(name)) actions.push({ op: "remove-skill", path: location.path, before: snapshot(actionPath(root, location.path)) });
  }
  for (const [path, record] of Object.entries(previous?.projections ?? {})) {
    if (!projections[path] && !selection.removeSkills.includes(record.skill)) projections[path] = { ...record, retained: true };
  }
  const legacyInstructions = { ...(previous?.legacyInstructions ?? {}) };
  for (const [path, record] of Object.entries(previous?.files ?? {})) if (record.kind === "instruction" && previous.schemaVersion !== 3) legacyInstructions[path] = record;
  for (const path of selection.instructionFiles) delete legacyInstructions[path];
  const lock = {
    schemaVersion: 3, managerVersion: "2.0.0", catalogHash: catalog.hash, catalogSource: catalog.catalogSource, instructions,
    source: { repository: catalog.repository, ref: catalog.ref },
    selection, skills: { ...(previous?.skills ?? {}), ...skills }, files, projections, legacyInstructions,
  };
  for (const name of selection.removeSkills) delete lock.skills[name];
  portable(lock);
  // Populate guidance and deferred documents before activating the startup imports.
  const activation = ["DOCUMENTATION.md", "VALIDATION.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"];
  actions.sort((a, b) => (activation.indexOf(a.path) + 1) - (activation.indexOf(b.path) + 1));
  const lockBefore = snapshot(actionPath(root, LOCK_PATH));
  const lockBytes = `${JSON.stringify(lock, null, 2)}\n`;
  if (lockBefore.type !== "file" || lockBefore.sha256 !== digest(lockBytes)) actions.push({ op: "lock", path: LOCK_PATH, before: lockBefore, sha256: digest(lockBytes) });
  const result = { mode: "plan", root, stage, catalogPath: catalog.path, targetHead: runGit(root, ["rev-parse", "HEAD"]), targetBranch: runGit(root, ["branch", "--show-current"]), selection, actions, lock, manifestHash: digest(manifest), legacyLockMigration: previous?.schemaVersion === 1 };
  return { ...result, planId: digest(result) };
}
export function applySync(options) {
  check(options.apply === true && options.confirm === true && typeof options.planId === "string", "Apply needs --apply --confirm --plan-id", 2);
  const plan = planSync(options);
  check(plan.planId === options.planId, "Plan is stale; inspect and approve a new plan");
  isolated(plan.root);
  for (const action of plan.actions) check(equal(snapshot(actionPath(plan.root, action.path, plan.selection.instructionFiles)), action.before), `Destination changed: ${action.path}`);
  // All inputs are checked before the first target mutation. The lock is always last.
  for (const action of plan.actions) {
    const path = actionPath(plan.root, action.path, plan.selection.instructionFiles);
    check(equal(snapshot(path), action.before), `Interrupted apply: destination changed: ${action.path}`);
    if (action.op === "write") {
      const bytes = readBytes(plan.stage, action.from);
      check(digest(bytes) === action.sha256, `Candidate changed: ${action.path}`);
      writeBytes(plan.root, action.path, bytes, action.mode);
    } else if (action.op === "lock") writeJson(plan.root, LOCK_PATH, plan.lock);
    else if (action.op === "link") {
      rmSync(path, { recursive: true, force: true }); mkdirSync(dirname(path), { recursive: true }); symlinkSync(action.target, path);
    } else { rmSync(path, { recursive: action.op === "remove-skill", force: true }); }
  }
  return { mode: "applied", planId: plan.planId, actionCount: plan.actions.length, installedSkills: plan.selection.selectedSkills, removedSkills: plan.selection.removeSkills, harnesses: plan.selection.harnesses, instructionFiles: plan.selection.instructionFiles, lock: LOCK_PATH };
}
export function projectStatus(root) {
  root = gitRoot(root); const lock = readLock(root);
  return { root, schemaVersion: lock?.schemaVersion ?? null, files: Object.entries(lock?.files ?? {}).filter(([, r]) => r.kind !== "instruction" || lock.schemaVersion === 3).map(([path, record]) => ({ path, state: matchesFile(snapshot(safePath(root, path)), record.installedSha256, record.mode) ? "clean" : "modified-or-missing" })), projections: Object.entries(lock?.projections ?? {}).map(([path, record]) => ({ path, state: equal(snapshot(safePath(root, path)), { type: "link", target: record.target }) ? "clean" : "conflict-or-missing" })) };
}
export function planSetup({ home = homedir(), managerRoot, harnesses }) {
  home = resolve(home); managerRoot = resolve(managerRoot ?? join(home, SKILLS, "sync-my-skills"));
  strings(harnesses, "harnesses"); check(harnesses.length && harnesses.every((h) => HARNESSES.includes(h)), "Confirm setup harnesses");
  noLinks(home, home); noLinks(managerRoot, managerRoot);
  frontmatter(readBytes(managerRoot, "SKILL.md").toString(), "sync-my-skills");
  const actions = [];
  for (const harness of harnesses) {
    const path = harness === "pi" ? ".pi/agent/prompts/sync-my-skills.md" : harness === "opencode" ? ".config/opencode/commands/sync-my-skills.md" : ".claude/skills/sync-my-skills";
    const absolute = safePath(home, path); noLinks(home, dirname(absolute)); const before = snapshot(absolute);
    if (harness === "claude-code") {
      const target = relative(dirname(absolute), managerRoot).split(sep).join("/");
      check(before.type === "missing" || (before.type === "link" && before.target === target), "Personal Claude skill destination conflicts; do not overwrite it");
      if (before.type === "missing") actions.push({ op: "link", path, target, before });
    } else {
      const content = readBytes(managerRoot, `assets/commands/${harness}.md`).toString(); const hash = digest(content);
      check(before.type === "missing" || (before.type === "file" && before.sha256 === hash), "Personal command conflicts; do not overwrite it");
      if (before.type === "missing") actions.push({ op: "write", path, content, before });
    }
  }
  const result = { mode: "setup-plan", home, managerRoot, harnesses: [...harnesses].sort(), managerHash: fingerprint(managerRoot), actions };
  return { ...result, planId: digest(result) };
}
export function applySetup(options) {
  check(options.apply === true && options.confirm === true && typeof options.planId === "string", "Setup needs --apply --confirm --plan-id", 2);
  const plan = planSetup(options); check(plan.planId === options.planId, "Setup plan is stale");
  for (const action of plan.actions) {
    const path = safePath(plan.home, action.path); noLinks(plan.home, dirname(path));
    check(equal(snapshot(path), action.before), "Personal command changed during setup");
    if (action.op === "write") writeBytes(plan.home, action.path, action.content);
    else { mkdirSync(dirname(path), { recursive: true }); symlinkSync(action.target, path); }
  }
  return { mode: "setup-applied", harnesses: plan.harnesses, actionCount: plan.actions.length, reloadRequired: true };
}
