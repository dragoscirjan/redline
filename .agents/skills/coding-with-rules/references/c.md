# C rules

## Types, interfaces, and lifetime

- `.c` identifies C; a `.h` header's language comes from its includers, build configuration, compiler invocation, and public interface. Shared C/C++ headers need the project's C-compatible linkage.
- Language standard, compiler, target ABI, cross-compilation, and freestanding constraints define available features.
- Make allocation, borrowing, transfer, and cleanup responsibilities explicit. Preserve public symbol visibility, calling conventions, and data layout.
- Check integer narrowing, signedness changes, overflow, and allocation-size multiplication before indexing, allocation, or pointer movement.
- Initialize objects before use. Preserve return-value errors at a boundary that can handle them.
- Prefer typed functions and constants to function-like macros. Unavoidable macros must parenthesize parameters and avoid repeated evaluation.
- Use one clear cleanup strategy for partially initialized resources.

## Memory and concurrency

- Validate capacities, lengths, indexes, pointer validity, alignment, and termination before memory access.
- Respect object lifetime, provenance, and aliasing. Freed, uninitialized, out-of-bounds, misaligned, or invalidly aliased storage is not usable.
- Signed overflow, shifts, integer conversions, variadic arguments, format strings, and overlapping copies can cause undefined or implementation-defined behavior.
- Bound buffer operations by known capacities; external input may lack termination or valid encoding.
- Untrusted values must not become format strings or shell source. Validate values crossing foreign-function boundaries.
- Shared state needs appropriate atomics or synchronization. Signal handlers are limited to the platform's documented safe operations.

## Tool defaults

- Tests: [CMocka](https://cmocka.org/); [CTest](https://cmake.org/cmake/help/latest/manual/ctest.1.html) only for CMake-owned builds.
- Formatting: [clang-format](https://clang.llvm.org/docs/ClangFormat.html).
- Analysis: compiler warnings, [clang-tidy](https://clang.llvm.org/extra/clang-tidy/), and [Cppcheck](https://cppcheck.sourceforge.io/) where supported by the selected C dialect and target.
- Memory diagnostics: [AddressSanitizer](https://clang.llvm.org/docs/AddressSanitizer.html) and [UndefinedBehaviorSanitizer](https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html).
- Language-specific failure cases include allocation failure, partial initialization, buffer boundaries, cleanup, and target-specific behavior.

Reference: [SEI CERT C Coding Standard](https://wiki.sei.cmu.edu/confluence/display/c/SEI+CERT+C+Coding+Standard).
