# .jsx rules

Prerequisite: Read [JavaScript rules](js.md) first. If already loaded for this task, do not read it again.

- JSX transformation and rendering semantics belong to the configured compiler/runtime; React, browsers, and virtual DOMs are not universal defaults.
- Elements, fragments, attributes, events, component properties, and render results must match that runtime's contracts.
- Framework lifecycle, ownership, effect, and reactivity rules are not interchangeable across JSX frameworks.
- Render functions remain pure where the framework requires purity; effects belong at explicit framework effect boundaries.
- Normal contextual escaping protects rendered text, not every sink.
- URL schemes/destinations, style values, and spread property keys/values need validation or allowlisting before rendering.
- Raw-markup and escaping-bypass APIs require a demonstrated need and context-appropriate sanitization.
- UI output needs semantic elements, labels, keyboard access, focus behavior, and accessibility consistent with [WCAG](https://www.w3.org/WAI/standards-guidelines/wcag/).
- Observable rendering and accessibility behavior, not serialized internal structure alone, define UI compatibility.
