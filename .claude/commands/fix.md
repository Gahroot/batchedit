---
name: fix
description: Run typechecking and linting, then spawn parallel agents to fix all issues
---

# Project Code Quality Check

Run all quality checks, collect errors, and spawn parallel agents to fix them.

## Step 1: Run Typechecking

Run the electron-vite build (includes TypeScript strict mode type checking):

```bash
npx electron-vite build 2>&1
```

## Step 2: Collect and Parse Errors

Parse the build output. Group errors by domain:
- **Type errors**: TypeScript type errors (TS2xxx codes)
- **Build errors**: Vite/Rollup resolution or bundling errors

Create a list of all files with issues and the specific problems in each file.

## Step 3: Spawn Parallel Agents

For each domain that has issues, spawn an agent in parallel using the Task tool:

**IMPORTANT**: Use a SINGLE response with MULTIPLE Task tool calls to run agents in parallel.

Each agent should:
1. Receive the list of files and specific errors in their domain
2. Fix all errors in their domain
3. Run `npx electron-vite build` to verify fixes
4. Report completion

## Step 4: Verify All Fixes

After all agents complete, run the full build again to ensure all issues are resolved:

```bash
npx electron-vite build
```
