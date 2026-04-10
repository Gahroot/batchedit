---
name: test
description: Run all tests, then spawn parallel agents to fix any failures
---

## Step 1: Run All Tests

```bash
npx vitest run
```

If all tests pass, report success and stop.

## Step 2: If Tests Fail

Parse the failure output. Group failures by test file.

## Step 3: Spawn Parallel Fix Agents

For each failing test file, spawn a Task agent (subagent_type: general-purpose) in parallel in a SINGLE response.

Each agent should:
1. Read the failing test file and the source file it tests
2. Determine if the bug is in the source code or the test
3. Fix the issue
4. Run `npx vitest run <file>` to verify

## Step 4: Verify All Fixes

```bash
npx vitest run
```

Confirm all tests pass.
