---
name: coding-js
description: Write, refactor, review, or test JavaScript in .js files for browser, Node.js, Deno, Bun, or embedded runtimes. Use for JavaScript work and combine with coding-mjs, coding-cjs, or coding-jsx when those extension semantics apply.
compatibility: Requires the coding skill and the JavaScript runtime and toolchain selected by the project.
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# JavaScript coding

Apply the generic `coding` workflow, then apply the JavaScript-specific rules in this skill.

## Load the dependency

Locate the advertised `coding` skill by exact name and path. If it is not already loaded, read its `SKILL.md` before continuing.

If `coding` is unavailable, stop and ask the human to install or expose it. Do not install it automatically, copy its instructions into this skill, or assume its contents from memory.

For `.mjs`, `.cjs`, or `.jsx` files, also load the matching extension skill after this one.

## Follow project and language guidance

Inspect `package.json`, the lockfile, runtime declarations, module settings, build configuration, lint and formatter configuration, tests, and CI before editing.

Use the [MDN JavaScript Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide) for current language guidance. The [Google JavaScript Style Guide](https://google.github.io/styleguide/jsguide.html) is an archived secondary reference; Google no longer updates it and recommends TypeScript for new Google code. Existing project conventions take precedence when they are safe and internally consistent.

## Write idiomatic JavaScript

- Target the runtime versions declared by the project. Do not use unsupported syntax or APIs.
- Preserve the project's module format. Do not mix ECMAScript modules and CommonJS without an explicit interoperability boundary.
- Prefer `const`. Use `let` only for intentional reassignment. Do not introduce `var` into modern code.
- Prefer strict equality unless a documented coercion is required.
- Use clear control flow and explicit return values. Avoid clever coercion and hidden mutation.
- Prefer small pure transformations for simple logic. Keep I/O, clocks, randomness, process state, and browser globals at explicit boundaries.
- Await or return promises deliberately. Handle rejection, cancellation, timeout, and cleanup paths when they matter.
- Preserve error causes and add context at the layer that can act on the failure.
- Use platform and standard-library APIs before adding a dependency.
- Preserve public exports and runtime behavior unless the approved task changes them.

## Apply JavaScript security controls

- Do not use `eval`, the `Function` constructor, or string-built timers for untrusted content.
- Treat parsed JSON, URL values, messages, DOM values, environment variables, and package data as untrusted at their boundaries.
- Avoid unsafe prototype writes and guard dynamic property access where attacker-controlled keys are possible.
- Use contextual output encoding and safe DOM APIs. Do not insert untrusted markup.
- Pass subprocess arguments as arrays and keep untrusted data out of shell command strings.
- Keep credentials and tokens out of client bundles, source maps, logs, and exceptions.
- Do not change lockfiles unless the task requires an approved dependency change. Inspect relevant package risks without adding an unconfigured audit gate.

## Test and run Redline's JavaScript gate

Test observable behavior, asynchronous success and failure, relevant runtime boundaries, and security regressions with the project's existing tools. Redline uses Node.js 24, pnpm, Vitest, and Bats. Run focused tests, then `mise run validate` before pushing. Do not add or suggest a fallback formatter, linter, duplicate detector, package-audit tool, or Tempel package for this task. Report checks that could not run rather than claiming a pass.
