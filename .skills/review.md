---
icon: "\U0001F50D"
description: Launch 3 parallel subagents to review code changes
placeholder: optional focus area
target: reviewer
---

Review the code changes on the current branch. Use `gh pr diff` to get the diff (if no PR exists, use `git diff origin/main...HEAD`).

Launch **3 parallel subagents**, each reviewing the full diff from a different angle:

1. **Correctness**: Check for logic errors, edge cases, off-by-one mistakes, undefined behavior, race conditions, and security issues (injection, XSS, etc.).
2. **Style & Design**: Check naming conventions, code organization, abstraction quality, and whether existing utilities/patterns are being reused instead of reinvented.
3. **Test Coverage**: Check whether new functionality has adequate tests, edge cases are covered, and no existing tests were broken or weakened.

After all 3 subagents report back, synthesize their findings into a single summary. Group issues by severity (critical / suggestion). Reply in Chinese (中文). {args}
