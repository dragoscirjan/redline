# POSIX shell coding

`coding-sh` adds portable POSIX shell guidance to the generic [`coding`](../coding/SKILL.md) workflow. It applies to `.sh` files and shell fragments that must run under a project-selected POSIX-compatible `sh`.

## Sources

- [POSIX Shell Command Language](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html)
- [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html), only where its Bash-oriented guidance is compatible with the project's POSIX requirements

The project's actual interpreter, operating systems, utilities, and portability contract take precedence.

## Fallback quality tools

When the project has no configured choice, the skill recommends:

- [ShellSpec](https://shellspec.info/)
- [shfmt](https://github.com/mvdan/sh) in a POSIX-compatible mode
- [ShellCheck](https://www.shellcheck.net/) with the selected shell dialect
- syntax checks with each supported POSIX shell
- [jscpd](https://jscpd.dev/) for duplicate detection

Shell has no universal dependency-vulnerability audit. The agent reports that category as unsupported when no package or image audit applies.

Existing project configuration takes precedence. The agent must not install or reconfigure shells, utilities, formatters, linters, or tests without human approval.

## Dependency contract

`coding-sh` requires `coding`. The agent resolves it through the active harness's advertised skill names and paths, loads it first, and stops when it is unavailable. The skill does not rely on a harness-specific Skill tool.

## Invocation

Pi:

```text
/skill:coding-sh Update this POSIX shell script and run the configured gates.
```

OpenCode:

```text
/coding-sh Update this POSIX shell script and run the configured gates.
```

## Files

- [`SKILL.md`](SKILL.md) contains the agent instructions.
- `README.md` documents sources, tools, and composition.

See [issue 25](https://github.com/dragoscirjan/ai/issues/25) for the implementation requirements.
