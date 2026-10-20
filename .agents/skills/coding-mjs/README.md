# MJS coding

`coding-mjs` adds `.mjs` ECMAScript-module semantics to [`coding-js`](../coding-js/SKILL.md) and the generic [`coding`](../coding/SKILL.md) workflow.

## Scope

The skill covers:

- ESM imports and exports
- runtime-specific specifier resolution
- `import.meta` and module-relative resources
- top-level await
- package export maps
- CommonJS interoperability and dual-package hazards

References:

- [MDN JavaScript modules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
- [Node.js packages and module formats](https://nodejs.org/api/packages.html)

## Dependencies

Load `coding`, `coding-js`, and `coding-mjs` in that order. All are sibling skills. Stop when a dependency is unavailable; do not install it automatically.

## Invocation

- Pi: `/skill:coding-mjs`
- OpenCode: `/coding-mjs`

See [issue 17](https://github.com/dragoscirjan/ai/issues/17) for the implementation requirements.
