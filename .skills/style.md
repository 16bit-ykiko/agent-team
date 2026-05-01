---
icon: "\U0001F3A8"
description: Check code style against project conventions
placeholder: optional file or focus area
---

Check the code changes on the current branch for style violations.

Steps:

1. Read the project's style guide — check `CLAUDE.md`, `.claude/CLAUDE.md`, `CONTRIBUTING.md`, or similar docs in the repo root. These define the project-specific coding conventions.
2. Get the diff: use `gh pr diff` if a PR exists, otherwise `git diff origin/main...HEAD`.
3. Review every changed file against the project's style rules. Check for:
   - **Naming conventions**: variable, function, class, enum naming patterns
   - **Language idioms**: are modern language features used correctly? Any anti-patterns?
   - **Parameter passing**: correct use of references, const, value types per project conventions
   - **Error handling**: does it follow the project's error handling patterns?
   - **Code organization**: does new code follow the same structure as existing similar code?
   - **Reuse**: is the change reinventing something the project already has? Check for existing utilities/helpers before flagging.
4. Report violations grouped by file with line numbers. For each violation, show the offending code and the correct pattern. Reply in Chinese (中文). {args}
