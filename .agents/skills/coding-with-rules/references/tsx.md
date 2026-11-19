# .tsx rules

Prerequisite: Read [TypeScript rules](ts.md) first. If already loaded for this task, do not read it again.

- `jsx`, `jsxImportSource`, framework types, and the renderer define TypeScript JSX semantics. Do not assume React.
- Element, intrinsic-element, property, children, event, and ref types come from the configured runtime.
- Preserve public component/property contracts; use inference internally and explicit types at exported boundaries.
- Generic component types should express real caller relationships, not broad unvalidated shapes.
- Types are erased. Data reaching rendering or privileged callbacks still needs runtime validation.
- Lifecycle, ownership, effects, purity, and reactivity follow the configured framework.
- Normal text escaping does not secure URL schemes/destinations, styles, or spread keys/values; validate those sinks.
- Raw markup and escaping bypasses require a demonstrated need and context-appropriate sanitization.
- UI output needs semantic structure, labels, keyboard access, focus behavior, and [WCAG](https://www.w3.org/WAI/standards-guidelines/wcag/) accessibility.
- Runtime rendering, validation, and accessibility remain distinct from type checking and serialized implementation structure.

Reference: [TypeScript JSX](https://www.typescriptlang.org/docs/handbook/jsx.html).
