# .mjs rules

Prerequisite: Read [JavaScript rules](js.md) first. If already loaded for this task, do not read it again.

- `.mjs` is an ECMAScript module regardless of the nearest `package.json` `type` field.
- Use `import` and `export`. `require`, `module.exports`, `exports`, `__filename`, and `__dirname` are not native ESM globals.
- Use supported `import.meta` and URL-aware APIs for module-relative resources.
- Specifiers and file extensions must follow the target runtime; Node.js rules are not universal browser, Deno, or Bun rules.
- Preserve conditional package exports and existing consumer behavior.
- CommonJS interoperability must handle default and named export conversion explicitly.
- Top-level `await` affects module evaluation order and startup latency.
- Avoid separate ESM/CommonJS instances of state that must share identity.
- Module behavior must hold through the actual ESM loader, not only a transformed test environment.

References: [MDN modules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules), [Node.js packages](https://nodejs.org/api/packages.html).
