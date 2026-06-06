---
name: commit
description: Run checks, commit with AI message, and push
---

1. Run quality checks (fix ALL errors before continuing):
   npm run lint     # biome lint (auto-fix: npx biome check --write .)
   npm run build    # electron-vite build = typecheck (no standalone tsc)
   npm test         # vitest jsdom; also `npm run test:main` if src/main/** changed

2. Review changes: run git status and git diff --staged and git diff

3. Stage relevant files with git add (specific files, not -A)

4. Generate a commit message:
   - Start with verb (Add/Update/Fix/Remove/Refactor)
   - Be specific and concise, one line preferred

5. Commit and push: git commit -m "your generated message" && git push
