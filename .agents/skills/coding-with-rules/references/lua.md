# Lua rules

## Runtime and tables

- Lua 5.1–5.4 and LuaJIT differ in syntax, libraries, numbers, garbage collection, and C APIs. Documentation and `luac` must match the selected runtime.
- Prefer `local` bindings and explicit module exports; avoid accidental globals.
- `nil`, `false`, missing keys, and absent return values have different meanings. Holes make table sequence length and iteration unreliable.
- Multiple returns, varargs, method-call syntax, and metamethod dispatch can change call behavior.
- Module resolution depends on `package.path`, `package.cpath`, host embedding, and bundling.
- Preserve traceback information at recoverable boundaries. Protected calls are not a substitute for handling an error.
- Files, handles, native resources, and temporary state need cleanup mechanisms supported by the selected Lua version.

## Executable boundaries

- Untrusted text must not reach `load`, `loadfile`, `dofile`, legacy `loadstring`, or equivalent host evaluators.
- A restricted environment is unsafe if it exposes powerful capabilities. The debug library, bytecode loader, FFI, and C modules are privileged.
- `os.execute`, `io.popen`, module paths, format strings, and native calls must not interpret untrusted data as code.
- Bound pattern matching, recursion, allocation, and instruction use for attacker-controlled workloads.
- Validate filesystem containment and native-module results where sandbox boundaries depend on them.

## Tool defaults

- Tests: [Busted](https://lunarmodules.github.io/busted/).
- Formatting: [StyLua](https://github.com/JohnnyMorganz/StyLua).
- Analysis: [Luacheck](https://github.com/lunarmodules/luacheck), including accidental globals.
- Syntax: the selected runtime's compatible compiler/interpreter. A different `luac` version does not prove compatibility.
- Relevant cases include nil/false distinctions, table holes, multiple returns, module loading, cleanup, and native integration.
- There is no universal Lua dependency-vulnerability audit; LuaRocks resolution is not vulnerability analysis.

References: the runtime-matched [Lua manual](https://www.lua.org/manual/5.4/manual.html), [LuaRocks style guide](https://github.com/luarocks/lua-style-guide).
