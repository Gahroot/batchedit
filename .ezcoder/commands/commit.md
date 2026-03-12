---
name: commit
description: Run checks, commit with AI message, and push
---

1. Run quality checks — fix ALL errors before continuing:
   npx electron-vite build
   npm test

2. Run `git status` and `git diff` to review all changes.

3. Stage relevant files with `git add` (specific files, not -A).

4. Generate a concise commit message starting with a verb (Add/Update/Fix/Remove/Refactor).

5. Run `git commit -m "<message>"` then `git push`.
