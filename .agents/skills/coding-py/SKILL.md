---
name: coding-py
description: Write, refactor, review, or test Python with explicit data and resource boundaries, compatible typing and packaging, safe dynamic behavior, dependency checks, and project-first quality gates. Use for .py files and Python package, build, or test work.
compatibility: Requires the coding skill and the Python interpreters, environment, package tooling, and analysis tools selected by the project.
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# Python coding

Apply the generic `coding` workflow, then apply the Python-specific rules in this skill.

## Load the dependency

Locate the advertised `coding` skill by exact name and path. If it is not already loaded, read its `SKILL.md` before continuing.

If `coding` is unavailable, stop and ask the human to install or expose it. Do not install it automatically, copy its instructions into this skill, or assume its contents from memory.

## Follow project and language guidance

Inspect `pyproject.toml`, supported interpreter versions, environment and dependency files, lockfiles, packaging metadata, import layout, formatter and lint settings, type-checker configuration, tests, documentation, and CI before editing. Use the project's environment and commands. Do not update dependencies, lockfiles, package metadata, or minimum Python version unless the approved task requires it.

Use the [Google Python Style Guide](https://google.github.io/styleguide/pyguide.html) and [PEP 8](https://peps.python.org/pep-0008/) as external guidance. Safe, internally consistent project conventions and configured formatters take precedence over stylistic defaults.

## Write idiomatic Python

- Target the Python versions and implementations declared by the project. Do not use unsupported syntax, standard-library APIs, or annotation forms.
- Prefer clear functions, explicit data flow, and standard-library facilities. Keep I/O, time, randomness, environment access, and global mutation at visible boundaries.
- Use context managers for files, locks, transactions, temporary resources, and other scoped lifetimes.
- Avoid mutable default arguments and unintended shared class state. Copy or freeze data only when ownership or mutation boundaries require it.
- Raise specific exceptions, preserve causes, and add context where callers can act on it. Do not catch broad exceptions merely to continue or hide failure.
- Handle coroutine cancellation, task ownership, timeouts, and asynchronous cleanup deliberately. Do not block an event loop with synchronous work without an explicit boundary.
- Use type annotations to communicate contracts, not to replace runtime validation. Avoid broad `Any`, casts, and ignores that conceal an unmodeled boundary.
- Preserve public imports, call signatures, serialization formats, CLI behavior, and package compatibility unless the approved task changes them.

## Enforce Python security boundaries

- Treat request data, parsed documents, environment variables, paths, package metadata, and deserialized values as untrusted at entry points.
- Do not use `eval`, `exec`, or dynamic imports for untrusted content. Treat `pickle`, `marshal`, `shelve`, and unsafe YAML loading as code-execution boundaries.
- Parameterize database queries. Apply context-specific encoding or validation for HTML, templates, headers, URLs, redirects, and structured output.
- Pass subprocess arguments as a sequence and avoid `shell=True`. If a shell is required, keep untrusted values out of the command string.
- Validate path containment, symlink behavior, archive members, and upload names before filesystem writes or extraction.
- Bound network reads, parsing, decompression, retries, regular-expression work, and concurrency when inputs can be attacker-controlled.
- Keep credentials and personal data out of source, logs, exceptions, snapshots, and generated artifacts.
- Review direct and transitive dependencies through the project's selected package and lockfile workflow.

## Test and run Python gates

Use the project's commands and configured tools first. When the project has no configured choice, ask before installing or configuring these fallbacks:

- [pytest](https://docs.pytest.org/) for focused and broader tests
- [Ruff](https://docs.astral.sh/ruff/) for formatting and linting
- [Pyright](https://microsoft.github.io/pyright/) for static type checking
- [Bandit](https://bandit.readthedocs.io/) for security-focused static checks
- [pip-audit](https://pypi.org/project/pip-audit/) for Python package vulnerability auditing
- [Pylint](https://pylint.readthedocs.io/) only for project-relevant checks not already covered by the selected lint configuration
- [jscpd](https://jscpd.dev/) as the duplicate detector when the project has no configured alternative

Test observable behavior, invalid input, exception and cleanup paths, relevant interpreter versions, synchronous and asynchronous boundaries, packaging behavior, and security regressions. Use property tests, fuzzing, or coverage only when the project already supports them or the human approves adding them.

Apply only project-defined thresholds. Report every applicable gate as passed, failed, not run, or unsupported. Never describe an unchecked interpreter, dependency set, type boundary, or unavailable audit as passed.
