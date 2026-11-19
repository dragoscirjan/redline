# GDScript rules

## Engine and lifecycle

- GDScript syntax and engine APIs depend on the pinned Godot version, renderer, and export targets. Typed/dynamic policy must not hide incompatibilities behind broad `Variant` values or unsafe casts.
- Scene-tree ownership determines who creates, adds, removes, queues, and frees each node. References may become invalid after lifecycle changes.
- Signal connections follow node lifetime; avoid duplicate connections and disconnect where required.
- `_process` handles frame work; `_physics_process` handles fixed-step physics. Use the appropriate delta and avoid unnecessary per-frame allocation or tree lookup.
- Initialize scene-dependent references at the correct lifecycle point. Exported properties, autoloads, and shared or duplicated resources have distinct ownership.
- `await`, timers, tweens, deferred calls, and asynchronous signals must account for cancellation and freed instances.
- Scene paths, serialized properties, signal contracts, save formats, and input actions are public engine-facing contracts.

## Resource and multiplayer boundaries

- Saves, mods, imported assets, resource paths, packets, and RPC arguments require validation before use.
- State-changing RPCs need checks on the authoritative peer. Client identity, position, inventory, timing, and permissions are not authoritative.
- Constrain dynamic resource paths and writes to intended filesystem locations.
- Untrusted text must not become GDScript, expressions, shaders, or dynamic calls. Addons, editor plugins, resource scripts, and native extensions execute code.
- Bound decompression, spawned nodes, physics objects, queued work, and messages.
- Exported resources and client builds must not contain secrets.

## Tool defaults

- Parser, import, and headless-load checks use the supported Godot version.
- Tests: [GdUnit4](https://github.com/MikeSchulze/gdUnit4) or [GUT](https://github.com/bitwes/Gut) only when compatible with that version.
- Formatting/analysis: [gdformat and gdlint](https://github.com/Scony/godot-gdscript-toolkit) only when gdtoolkit supports the selected syntax.
- Relevant cases include scene lifecycle, signal connections, save compatibility, async cancellation, authoritative RPCs, and export-specific behavior.
- Godot addons have no universal dependency-vulnerability audit.

References: official [GDScript reference](https://docs.godotengine.org/en/stable/tutorials/scripting/gdscript/gdscript_basics.html), [style guide](https://docs.godotengine.org/en/stable/tutorials/scripting/gdscript/gdscript_styleguide.html), and [typing guidance](https://docs.godotengine.org/en/stable/tutorials/scripting/gdscript/static_typing.html), matched to the supported engine version.
