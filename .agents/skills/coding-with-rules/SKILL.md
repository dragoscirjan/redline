---
name: coding-with-rules
description: "Language-aware coding: resolve the base workflow, then select rules for the languages and file extensions being changed."
requires: ["coding"]
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# Coding with rules

Use this composition for language-aware code and toolchain work. The declared `coding` requirement owns project inspection, shared security, tests, quality-gate order, duplicate detection, installation approval, and reporting.

## 1. Select the relevant contexts

Identify affected languages from files and project/runtime/build/interpreter evidence rather than filenames alone. Toolchain and configuration work uses the associated language's rules. Select every affected language, not every language present in the repository.

Resolve ambiguous headers and shell dialects from evidence; ask when unresolved. Choose Bash or POSIX guidance to match the interpreter, not contradictory dialect rules together. Conflicting interpreter evidence blocks the work.

## 2. Read the selected references

Before designing, changing, reviewing, or testing code, read each selected row in order. Resolve each document's linked prerequisites first and read each document once per task. Stop on a missing prerequisite, cycle, or missing mapped reference rather than substituting another language.

| Language or file context | References, in order |
|---|---|
| `.js`, JavaScript | [js](references/js.md) |
| `.mjs` | [js](references/js.md), [mjs](references/mjs.md) |
| `.cjs` | [js](references/js.md), [cjs](references/cjs.md) |
| `.jsx` | [js](references/js.md), [jsx](references/jsx.md) |
| `.ts`, TypeScript | [ts](references/ts.md) |
| `.mts` | [ts](references/ts.md), [mts](references/mts.md) |
| `.cts` | [ts](references/ts.md), [cts](references/cts.md) |
| `.tsx` | [ts](references/ts.md), [tsx](references/tsx.md) |
| `.c`, C headers | [c](references/c.md) |
| C++ source, headers, modules | [cpp](references/cpp.md) |
| `.gd`, Godot GDScript | [gdscript](references/gdscript.md) |
| `.go`, Go | [go](references/go.md) |
| `.lua`, Lua | [lua](references/lua.md) |
| `.php`, PHP | [php](references/php.md) |
| `.py`, Python | [py](references/py.md) |
| `.pyi` | [py](references/py.md), [pyi](references/pyi.md) |
| `.rs`, Rust | [rs](references/rs.md) |
| POSIX shell | [sh](references/sh.md) |
| Bash, including `.sh` with Bash interpreter evidence | [bash](references/bash.md) |
| `.swift`, Swift | [swift](references/swift.md) |
| `.zig`, Zig | [zig](references/zig.md) |

## 3. Apply and check coverage

References add language/extension rules and tool defaults; project configuration takes precedence. For an unsupported language, use the base workflow and project conventions and state that no language-specific reference exists. Invent no substitute rules.

Continue with code work only when every affected context has its applicable references loaded in order, or its unsupported-language fallback explicitly identified.
