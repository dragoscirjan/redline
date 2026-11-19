# JavaScript rules

## Values and modules

- Runtime declarations and package module settings constrain syntax and APIs. Preserve ECMAScript-module versus CommonJS boundaries.
- Prefer `const`; use `let` for reassignment. Avoid `var` in modern code.
- Prefer strict equality unless coercion is intentional and documented.
- Keep mutation and coercion explicit. JavaScript object and array aliases share mutable state.
- Await or return promises deliberately; rejection, cancellation, timeout, and cleanup remain distinct paths.
- Preserve error causes, public exports, and module initialization behavior.

## Runtime boundaries

- Untrusted content must not reach `eval`, the `Function` constructor, or string-built timers.
- Parsed JSON, messages, DOM values, URL values, and package metadata need validation before use.
- Guard prototype-sensitive writes and dynamic property access on attacker-controlled keys.
- Render text through safe DOM APIs and contextual encoding, not untrusted markup.
- Node subprocess APIs take argument arrays; do not convert untrusted values into shell source.
- Browser bundles and source maps can expose credentials and internal data.

## Tool defaults

The maintained [Tempel toolkit](https://github.com/dragoscirjan/tempel-javascript) provides compatible shared configurations:

- Tests: [`@tempel/vitest`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/vitest); [`@tempel/jest`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/jest) when Jest is selected.
- Lint: [`@tempel/eslint`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/eslint).
- Formatting: [`@tempel/prettier`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/prettier).
- Commit messages: [`@tempel/commitlint`](https://github.com/dragoscirjan/tempel-javascript/tree/main/packages/commitlint) when Conventional Commits are validated.
- Dependency vulnerabilities: the active package manager's audit command.

Tempel package versions must support the selected underlying tools. Runtime-specific behavior includes asynchronous rejection and execution in the actual supported environment.

Reference: [MDN JavaScript Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide). The [Google JavaScript Style Guide](https://google.github.io/styleguide/jsguide.html) is archived, not a maintained primary source.
