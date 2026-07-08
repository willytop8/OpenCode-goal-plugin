# opencode-goal-plugin demo

A minimal, reproducible demo: a failing test suite and a `/goal` that fixes
it autonomously, with no supervision after you set the goal.

`src/math.js` has a deliberate bug — `add(a, b)` returns `a - b` instead of
`a + b`. `test/math.test.js` catches it. The goal below tells the agent to
fix the failing tests; the plugin auto-continues the session until the
agent verifies the suite passes and reports evidence-backed completion.

## Prerequisites

- Node.js >= 18
- OpenCode installed (`opencode --version`)
- At least one provider configured (`opencode auth login`)

## Steps

1. From the repo root, confirm the bug is real:

   ```sh
   cd demo
   npm test
   ```

   You should see 2 failing tests — `add(2, 3)` returns `-1` instead of `5`.

2. Launch OpenCode in this directory. `demo/opencode.json` already points
   the plugin at the source file (`file:../src/goal-plugin.js`) and
   registers the `goal` command, so no install step is needed:

   ```sh
   opencode
   ```

3. Set the goal. If this `demo/` directory sits inside a larger checkout
   (e.g. you cloned the whole plugin repo), be specific about scope —
   "this repo" can otherwise be read as the surrounding project rather
   than the demo itself:

   ```
   /goal fix the failing tests in demo/test/math.test.js --max-turns 10
   ```

4. Walk away. The plugin keeps the goal in context, auto-continues after
   each idle turn, and stops when the agent reports a substantiated
   completion or a safety limit is reached (10 turns here).

5. Check the result:

   ```sh
   npm test
   ```

   Both tests should now pass, and `src/math.js` should return `a + b`.

## What to expect

- The agent should read `test/math.test.js`, find the failing assertions,
  locate the bug in `src/math.js`, fix `a - b` → `a + b`, rerun `npm test`
  to confirm, and end its response with a `[goal:evidence]` line
  summarizing what it verified, followed by `[goal:complete]`. A
  `[goal:complete]` with no preceding `[goal:evidence]` is rejected by the
  plugin and re-prompted — the agent can't just claim done, it has to show
  its work.
- Run `/goal status` at any point to see the current goal, elapsed
  turns/time/tokens, and remaining budget (plus the accepted evidence once
  complete). Run `/goal history` to see the lifecycle events and the
  latest checkpoint. Run `/goal list` to see all live/backgrounded goals
  in the session.
- **Hook output display varies by OpenCode version and provider** — the
  plugin's own status text may or may not render directly in the TUI (see
  the [compatibility table](../README.md#compatibility-snapshot)). Either
  way, the goal's state (limits, turn count, completion) is tracked
  correctly; you can always verify it directly by inspecting the
  persisted state at `.opencode/goals/state.json` in this directory.

## Resetting the demo

To run the demo again from a clean slate:

```sh
git checkout -- src/math.js
/goal clear
rm -rf .opencode/goals
```
