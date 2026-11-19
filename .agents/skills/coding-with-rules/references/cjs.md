# .cjs rules

Prerequisite: Read [JavaScript rules](js.md) first. If already loaded for this task, do not read it again.

- `.cjs` is CommonJS regardless of the nearest `package.json` `type` field.
- Preserve the public export shape. Replacing `module.exports` and mutating export properties are not interchangeable for all consumers.
- `require` resolution, cache identity, circular dependencies, and initialization order affect observable behavior.
- ESM interoperability through dynamic `import()` is asynchronous; handle namespace, default, and named exports explicitly.
- CommonJS evaluation is synchronous; top-level `await` is not permitted.
- `__filename` and `__dirname` exist only where the target runtime defines them.
- Preserve package `exports` `require` conditions and CommonJS entry points.
- Avoid parallel ESM/CommonJS instances of state that must share identity.
- Export-shape and interoperability compatibility must hold through the actual CommonJS loader, not only a transformed test environment.

Reference: [Node.js CommonJS modules](https://nodejs.org/api/modules.html).
