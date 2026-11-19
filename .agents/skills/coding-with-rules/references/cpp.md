# C++ rules

## Types and ownership

- C++ source, headers, and modules follow the project's extension and build conventions. Includers and compiler invocations determine ambiguous `.h` headers.
- The selected standard, standard library, ABI, exception policy, RTTI settings, and freestanding targets constrain available facilities.
- Use RAII for owned resources. Prefer automatic storage and value semantics; use explicit unique/shared ownership and non-owning pointers or references.
- Follow the rule of zero. Ownership and invariants must justify custom copy, move, and destruction behavior.
- Use `const`, scoped enumerations, vocabulary types, algorithms, ranges, and views where supported. Every non-owning view needs a valid lifetime.
- Prefer type-safe facilities to macros, C-style casts, sentinels, and untagged unions. Constrain templates around real contracts.
- Preserve `noexcept` guarantees, exception safety, public ABI, symbol visibility, and object layout.

## Memory and concurrency

- Validate sizes, indexes, iterators, conversions, and arithmetic before allocation or memory access.
- Avoid dangling pointers, references, iterators, spans, string views, and closure captures.
- Use owning raw `new`/`delete` only at unavoidable low-level boundaries; pair compatible allocation and deallocation mechanisms.
- Construction, moves, callbacks, and partial failure must preserve object invariants.
- Use scoped locks and explicit thread-safety contracts. `volatile` is not synchronization.
- Isolate unchecked casts, manual storage, pointer arithmetic, and lifetime extension behind documented invariants.
- Polymorphic bases need an appropriate destruction policy; avoid slicing.

## Tool defaults and standards

- Tests: [GoogleTest](https://google.github.io/googletest/); CTest only when CMake owns the build.
- Formatting: [clang-format](https://clang.llvm.org/docs/ClangFormat.html).
- Analysis: compiler warnings, [clang-tidy](https://clang.llvm.org/extra/clang-tidy/), [Cppcheck](https://cppcheck.sourceforge.io/), AddressSanitizer, and UndefinedBehaviorSanitizer where compatible.
- Relevant cases include copy/move transitions, exception paths, destruction, concurrency, and target-specific ABI behavior.
- The [JSF Air Vehicle C++ standard](https://www.stroustrup.com/JSF-AV-rules.pdf) is a 2005 C++03-era supplement only for governing safety-critical, embedded, avionics, defense, or explicit project requirements—not the modern-C++ default.

References: [C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/), [Google C++ Style Guide](https://google.github.io/styleguide/cppguide.html).
