# JavaScript coding

`coding-js` adds JavaScript-specific guidance to the generic [`coding`](../coding/SKILL.md) workflow. It applies to `.js` files and JavaScript runtimes such as browsers, Node.js, Deno, Bun, and embedded engines.

Load `coding-mjs`, `coding-cjs`, or `coding-jsx` after this skill when the file extension requires additional semantics.

## Sources

- [MDN JavaScript Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide) is the primary current language reference.
- [Google JavaScript Style Guide](https://google.github.io/styleguide/jsguide.html) is an archived secondary style reference. Google states that it is no longer updated and recommends TypeScript for new Google code.

Project conventions take precedence when they are safe and consistent.

## Fallback quality tools

When the project has no configured choice, the skill recommends maintained packages from the [Tempel JavaScript Development Toolkit](https://github.com/dragoscirjan/tempel-javascript):

- [`@tempel/vitest`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/vitest)
- [`@tempel/jest`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/jest) when the project uses Jest
- [`@tempel/eslint`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/eslint)
- [`@tempel/prettier`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/prettier)
- [`@tempel/commitlint`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/commitlint) when the repository validates Conventional Commits
- [jscpd](https://jscpd.dev/)
- the active package manager's audit command

Existing project configuration takes precedence. The agent must not install or reconfigure these tools without human approval.

## Dependency contract

`coding-js` requires `coding`. The agent resolves it through the active harness's advertised skill names and paths, loads it first, and stops when it is unavailable. The skill does not rely on a harness-specific Skill tool.

## Invocation

Pi:

```text
/skill:coding-js Update this JavaScript module and run the configured gates.
```

OpenCode:

```text
/coding-js Update this JavaScript module and run the configured gates.
```

## Files

- [`SKILL.md`](SKILL.md) contains the agent instructions.
- `README.md` documents sources, tools, and composition.

See [issue 17](https://github.com/dragoscirjan/ai/issues/17) for the implementation requirements.
