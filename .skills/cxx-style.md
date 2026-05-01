---
icon: "\U0001F3A8"
description: Check C++ code style against coding conventions
placeholder: optional file or focus area
---

Check C++ code changes on the current branch for style violations. Get the diff via `gh pr diff` (if a PR exists) or `git diff origin/main...HEAD`.

Review every changed C++ file against the following rules. Report violations grouped by file with line numbers, showing the offending code and the correct pattern. Reply in Chinese (中文).

{args}

---

## C++ Coding Style Rules

### Naming Conventions

- **Variables, member fields, function names**: `snake_case`. Class member fields do NOT use any suffix/prefix (no trailing `_`, no `m_` prefix).
- **Class names, template parameter names, enum names**: `PascalCase`. Exception: some class names also use `snake_case` — follow the existing style in the project.
- **Enum values**: `PascalCase`.

### Template & Type Traits

- Do NOT blindly add `std::remove_cvref_t` on every template parameter. Understand deduction rules:
  - `template<typename T> void f(T x)` — `T` is always deduced as non-reference, non-cv. No need for `remove_cvref_t`.
  - `template<typename T> void f(T& x)` — `T` is deduced as the referred-to type (possibly cv-qualified, never a reference). No `remove_cvref_t` needed.
  - `template<typename T> void f(const T& x)` — `T` is deduced as non-const, non-reference. No `remove_cvref_t` needed.
  - `template<typename T> void f(T&& x)` — **forwarding reference**: `T` CAN be an lvalue reference. This is the ONLY case where `std::remove_cvref_t<T>` is needed.
  - Class template parameters and return types are never deduced as references either.

### Type Traits & Concepts (C++20/23)

- Use variable templates directly for type traits. Do NOT wrap in a class template:

```cpp
// Good
template<typename T>
inline constexpr bool is_my_type_v = false;
template<>
inline constexpr bool is_my_type_v<MyType> = true;

// Bad
template<typename T>
struct is_my_type : std::false_type {};
template<>
struct is_my_type<MyType> : std::true_type {};
template<typename T>
inline constexpr bool is_my_type_v = is_my_type<T>::value;
```

- Concepts should NOT add `std::remove_cvref_t` unless specifically intended. The caller is responsible for passing the right type.

### Error Handling

- Prefer `if` with init-statements to scope error variables, but not when it forces an `else` block for the success path:

```cpp
// Good: operator bool, no redundant condition
if (auto err = foo()) { /* handle */ }

// Bad: redundant condition
if (auto err = foo(); err) { /* handle */ }

// Good: flat control flow with early return
auto result = get_data();
if (!result.has_value()) return result.error();
process(result.value());

// Bad: forced else nesting
if (auto result = get_data(); !result.has_value()) {
    return result.error();
} else {
    process(result.value());
}
```

### String Literals

- Prefer raw string literals `R"(...)"` over escaped strings. Avoid `\"`, `\\`, `\n` when a raw literal is cleaner.

### Modern C++ Usage

- Target C++20/23. Use modern APIs.
- Do NOT use `<iostream>` (`std::cout`, `std::cin`, `std::cerr`). Do NOT use C-style I/O (`printf`, `fprintf`).
- Prefer `std::ranges` / `std::views` over raw loops and traditional `<algorithm>`.
- Prefer LLVM data structures when the project depends on LLVM (`llvm::SmallVector`, `llvm::DenseMap`, `llvm::StringMap`, `llvm::StringRef`).

### Parameter Passing

- String: prefer `llvm::StringRef` > `std::string_view` > `const std::string&`.
- Array/span: prefer `llvm::ArrayRef` > `std::span` > `const std::vector&`.

### Misc

- Prefer `[[maybe_unused]]` over `(void)` for unused variables/parameters.
