---
icon: "\U0001F4DD"
description: Rewrite PR title and summary from actual diff
placeholder: optional focus or extra context
---

Update the current PR's title and body based on a thorough analysis of the actual code diff. Do NOT rely on commit messages — they may be vague or incomplete.

Steps:

1. Run `gh pr diff` to get the exact diff as GitHub sees it (avoids local/remote branch mismatch issues).
2. Carefully read through every changed file. Understand what was added, removed, and modified.
3. Write a new PR title (concise, under 70 chars) and body that accurately describes the changes:
   - **Summary**: 2-5 bullet points covering the key changes and their purpose (the "why", not just the "what").
   - **Details**: If there are non-obvious design decisions or trade-offs, briefly explain them.
4. Use `gh pr edit --title "..." --body "..."` to update the PR. {args}
