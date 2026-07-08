# opencode-goal-plugin

[![npm version](https://img.shields.io/npm/v/opencode-goal-plugin)](https://www.npmjs.com/package/opencode-goal-plugin)
[![npm downloads](https://img.shields.io/npm/dm/opencode-goal-plugin)](https://www.npmjs.com/package/opencode-goal-plugin)
[![CI](https://github.com/willytop8/OpenCode-goal-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/willytop8/OpenCode-goal-plugin/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-185%20passing-brightgreen)](test/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An experimental session-scoped `/goal` command for [OpenCode](https://opencode.ai/).

Set a goal and the plugin keeps it in context, auto-continues the session whenever the assistant goes idle, and stops when the goal is marked complete, a blocker is reported, or a safety limit is reached.

Compatibility: this plugin relies on experimental OpenCode hooks. Re-test against the exact OpenCode build and provider/backend stack you plan to use for unattended work.

## Comparison

| Feature | Claude Code | Codex | opencode-goal-plugin |
|---|---|---|---|
| `/goal` command | ✅ Native | ✅ Native | ✅ Plugin |
| Auto-continue | ✅ | ✅ | ✅ |
| Per-goal flag overrides | ❌ | ❌ | ✅ |
| No-progress / no-tool-call detection | ❌ | ❌ | ✅ Both |
| Configurable safety limits | Limited | Limited | ✅ All tunable |
| Goal history | ✅ | ❌ | ✅ `/goal history` |
| Goal persistence | ❌ | ❌ | ✅ Survives restart, ledger-backed |
| Multiple concurrent goals | ❌ | ❌ | ✅ `/goal add` / `/goal focus` |
| Ordered goal sequences | ❌ | ❌ | ✅ `/goal sisyphus` |
| Evidence-gated completion | ❌ | ❌ | ✅ `[goal:evidence]` required |
| Independent completion audit | ✅ | ❌ | ✅ Optional child-session auditor |
| Budget wrap-up prompts | ❌ | ❌ | ✅ 80% threshold |
| Open source | ❌ | ❌ | ✅ MIT |

## Compatibility snapshot

| Surface | Status |
|---|---|
| Node.js | Declared support: `>=18`; CI covers Node 18, 20, and 22 |
| Package entrypoint | `npm run smoke` verifies the package export path plus `/goal` command-hook behavior from a local install without invoking a model |
| OpenCode host | Manually smoke-tested against OpenCode 1.15.10 using the `opencode-go` provider (`qwen3.7-plus`) on this repo's local hardening branch; re-test your own version/provider stack before relying on unattended runs |
| Provider/backend quirks | Strict-template backends require the goal block to merge into the primary `system` message; covered by regression tests |

## Install

```sh
npm install opencode-goal-plugin
```

Add the plugin and command to your OpenCode config:

```json
{
  "plugin": ["opencode-goal-plugin"],
  "command": {
    "goal": {
      "description": "Set a session-scoped goal and auto-continue until complete.",
      "template": "$ARGUMENTS",
      "agent": "build"
    }
  }
}
```

## Usage

Set a goal:

```
/goal fix the failing tests and verify the suite passes
```

Override limits for a single goal:

```
/goal fix the failing tests --max-turns 20 --max-minutes 30 --max-tokens 400000
```

Add success criteria, constraints / non-goals, and a mode:

```
/goal ship the release --success "tests pass and changelog updated" --constraints "do not touch the public API" --mode ordered
```

`--success` (alias `--success-criteria`) and `--constraints` (alias `--non-goals`) take quoted text and are injected alongside the objective so the assistant keeps them in view. `--mode` is `normal` (default) or `ordered` (alias `sisyphus`); `ordered` asks the assistant to work through the objective as a strict sequence. Multi-word values must be quoted.

Flags accept either `--flag value` or `--flag=value`. If a flag is unknown, missing a value, given a non-positive integer, or (for `--mode`) an unrecognized mode, the plugin rejects the command with a helpful error instead of silently folding the bad flag into the goal text.

Check status:

```
/goal status
```

View lifecycle history and the latest checkpoint:

```
/goal history
```

Resume a paused or stopped goal:

```
/goal resume
```

Edit the active goal's objective without losing its budget or history:

```
/goal edit fix the failing tests and also update the docs
```

`/goal edit <new objective>` revises the goal in place: the turn, token, and time budget plus the lifecycle history are preserved, and any pause/blocked state is cleared so the revised goal can continue. A goal that already hit a hard limit will re-pause on the next idle — run `/goal resume` for a fresh budget window.

Pause without clearing the active goal:

```
/goal pause
```

Clear the active goal:

```
/goal clear
```

`/goal stop`, `/goal off`, `/goal reset`, `/goal none`, and `/goal cancel` are aliases for `/goal clear`.

### Multiple goals

A session can hold more than one goal. `/goal <condition>` replaces the focused goal, while `/goal add <condition>` keeps the current goal (backgrounding it) and focuses a new one. Only the **focused** goal is auto-continued; backgrounded goals are paused until you focus them.

```
/goal add write the migration guide
/goal list
/goal focus 1
```

`/goal list` shows the numbered live goals (which is focused, which are backgrounded) and a per-session archive of completed/cleared goals so they stay readable. `/goal focus <number>` switches the active goal, backgrounding the previous one. Focus is tracked per session and survives a restart.

#### Ordered (sisyphus) sequences

`/goal sisyphus` sets up a strict execution sequence: separate the objectives with `;` or newlines, and the plugin runs them one at a time, auto-focusing the next as soon as the current one completes.

```
/goal sisyphus build the parser; write the tests; ship the release
```

The first goal is focused and the rest are queued. `/goal list` marks the session as ordered. Auto-promotion stops when the sequence is exhausted; `/goal clear` ends the sequence.

## Examples

Copy-pasteable goals for common workflows:

```
/goal "fix the failing tests" --max-turns 10
/goal "refactor auth to use new API" --max-minutes 30
/goal "audit for security issues" --max-turns 3
/goal "migrate class components to functional" --max-minutes 60 --max-tokens 400000
```

With success criteria, constraints, and a token budget shorthand:

```
/goal "ship the release" --success "tests pass and changelog updated" --constraints "do not touch the public API" --budget 150k
```

An ordered sequence, run as a strict pipeline:

```
/goal sisyphus build the parser; write the tests; ship the release
```

## How it works

1. When you set a goal, the plugin stores it in session memory and injects it into the system prompt so the assistant keeps it in view on every turn.
2. Each time the session goes idle, the plugin sends a continuation prompt containing the goal, the remaining budget, and a completion audit asking the assistant to verify the current state before declaring done.
3. The plugin stops auto-continuing when the assistant ends a response with `[goal:complete]` or `[goal:blocked]`, or when a safety limit is reached.
4. If OpenCode compacts the session, the plugin injects a deterministic summary into the compaction context so the goal survives the compaction and the assistant keeps the thread. The summary — objective, status, budget usage, recent checkpoints, and recent lifecycle events — is reconstructed from the plugin's persisted goal record rather than from chat memory, so it is stable and reproducible. While a goal is active, the plugin also disables OpenCode's generic post-compaction auto-continue so it does not race the plugin's own continuation.
3. The plugin stops auto-continuing when the assistant ends a response with a substantiated `[goal:complete]` or `[goal:blocked]`, or when a safety limit is reached. A `[goal:complete]` is only honored when it is preceded by a `[goal:evidence]` line; a `[goal:blocked]` is only honored when a concrete blocker is stated. Unsubstantiated claims are rejected and the plugin re-prompts for the missing evidence or blocker.
4. If OpenCode compacts the session, the plugin injects the goal objective, budget usage, and latest checkpoint into the compaction context so the goal survives the compaction and the assistant keeps the thread. While a goal is active, the plugin also disables OpenCode's generic post-compaction auto-continue so it does not race the plugin's own continuation.
5. If you send a message of your own while the goal is running, the plugin treats it as the latest instruction and pauses auto-continue so it does not talk over you. The plugin's own continuation prompts are ignored for this check (they are not "your" messages). Run `/goal resume` to hand control back to the goal loop.

## Completion markers

The plugin stops when it sees one of these at the end of an assistant response:

```
[goal:evidence] ran npm test (83 passing), verified the build output
[goal:complete]
```
```
The deploy step needs a production API token I don't have.
[goal:blocked]
```

`[goal:complete]` — goal is satisfied. It is **only honored when the line immediately before it (or an earlier line) begins with `[goal:evidence]` and contains a non-empty summary** of what was verified (commands run and their results, files checked). A `[goal:complete]` with no `[goal:evidence]` line is rejected, not recorded, and the plugin re-prompts for evidence. The accepted evidence is shown in `/goal status` after completion.
`[goal:blocked]` — the assistant needs input from you. The line immediately before the marker must explain the specific blocker; `/goal status` shows it while the goal remains in memory. A `[goal:blocked]` with no concrete blocker is rejected and the plugin keeps working.

Markers must appear on their own final line. The bracketed form is canonical, but the plugin also accepts bare `goal:complete`, `goal:blocked`, and `goal:evidence` lines because some models omit brackets. Natural-language phrases like "goal complete" are intentionally ignored.

## Safety limits

| Limit | Default |
|---|---|
| Auto-continue turns | 10 |
| Max duration | 15 minutes |
| Context tokens | 200,000 |
| Min delay between continues | 1.5 seconds |
| No-progress pause | < 50 output tokens on a stalled turn (after a 2-turn grace window) |
| Budget wrap-up threshold | 80% of context token budget |
| Auto-continue failure pause | 3 consecutive prompt failures |

**Effective turn count.** Each LLM turn on a real task typically takes 30–90 seconds. At that latency, raising `--max-minutes` is usually more useful than raising `--max-turns`. At 45 s/turn, the default 15-minute window gives roughly 15–20 turns of headroom before the turn limit becomes the binding brake.

**Token budget.** The plugin tracks the session's context window size (`input + output + reasoning` tokens on the latest message). This matches the token count that OpenCode displays, so the numbers should be consistent. When the context window reaches the `--max-tokens` limit, the plugin sends a wrap-up prompt and stops. In high-context sessions (large codebases, long conversation history), the context can grow quickly — treat the budget as a safety brake.

**No-progress heuristic.** A low-output turn does not pause immediately anymore. The plugin pauses only after `noProgressTurnsBeforePause` consecutive *stalled* low-output turns — repeated turns with very little output and no meaningful change in the latest assistant checkpoint.

**No-tool-call heuristic.** Complementing the no-progress check, the plugin also watches for continuation turns that produce no tool calls at all (a "talk only" turn). Repeated talk-only turns usually mean the assistant is chatting to itself rather than doing work, so after `noToolCallTurnsBeforePause` consecutive tool-free continuation turns the plugin pauses. A turn that uses any tool (or delegates a subtask) resets the counter.

**Wrap-up vs. hard stop.** When a limit is reached, the plugin sends one final prompt asking the assistant to summarize what is done, what remains, and the next concrete step — rather than stopping silently. Use `/goal resume` to continue after any stop, including limit stops and no-progress pauses.

Goal state is persisted by default to a **project-local** path, `.opencode/goals/state.json` relative to the working directory, so goals follow the project rather than your home directory. It is only a local workflow checkpoint and is not synchronized across machines or OpenCode instances. You may want to add `.opencode/goals/` to your `.gitignore`.

The state-file location is resolved with this precedence:

1. the `stateFilePath` plugin option, if set;
2. the `OPENCODE_GOAL_STATE_PATH` environment variable, if set;
3. the project-local default `<cwd>/.opencode/goals/state.json`.

When the default path has no state yet, the plugin migrates forward from older locations on first load: the legacy `~/.opencode-goal-plugin/state.json` and the XDG path `${XDG_STATE_HOME:-~/.local/state}/opencode-goal-plugin/state.json`. An explicit `stateFilePath` or `OPENCODE_GOAL_STATE_PATH` is used literally with no migration fallback.

The state directory is created with owner-only permissions, and the JSON state file is written as `0600` because it may contain goal text, assistant checkpoints, and workflow history.

Alongside the state file the plugin keeps an **append-only lifecycle ledger** (`<stateFile>.ledger.jsonl`, also `0600`). Every lifecycle event — set, edit, auto-continue, pause, resume, blocked, completed, limit — is appended as one JSON line. Because the in-memory history is capped, the ledger is the durable record: if the main state file is missing or corrupted, the plugin reconstructs still-active (non-completed) goals from the ledger on startup and reloads them in the paused recovery state. Terminal events (complete/blocked) are written to the ledger *before* the main state write, so a goal's terminal outcome survives even if that write fails (**fail-closed**); such a failure is logged at error level.

Recovered active goals are loaded in a **paused** state with a recovery note, so unattended auto-continue does not resume blindly after a restart. Set `"persistState": false` to keep purely in-memory behavior (this also disables the ledger).

`/goal resume` continues the same objective with a fresh local budget window. This lets you continue after pause, blocker, no-progress pause, rate-limit failures, or a limit stop without retyping the objective.

### Per-goal flags

Override any limit for a single goal:

| Flag | Controls |
|---|---|
| `--max-turns <n>` | Auto-continue turn limit |
| `--max-minutes <n>` | Duration limit in minutes |
| `--max-duration-ms <n>` | Duration limit in milliseconds |
| `--max-tokens <n>` | Context token limit |
| `--budget <n>` | Context token limit shorthand; accepts a `k`/`m` suffix (e.g. `100k`, `1.5m`) |
| `--cooldown-ms <n>` | Minimum delay between continues |
| `--no-progress-threshold <n>` | Output token floor before pausing |
| `--no-progress-turns <n>` | Consecutive stalled low-output turns before pausing |
| `--success <text>` | Success criteria that define when the goal is satisfied (quote multi-word text) |
| `--constraints <text>` | Constraints / non-goals to respect (alias `--non-goals`) |
| `--mode <normal\|ordered>` | Execution mode; `ordered` (alias `sisyphus`) asks for a strict sequence |
| `--no-tool-turns <n>` | Consecutive tool-free continuation turns before pausing |

Examples:

```sh
/goal fix tests --max-turns 20 --max-tokens 400000
/goal fix tests --max-turns=20 --max-tokens=400000
/goal fix tests --no-progress-threshold 50 --no-progress-turns 2
/goal fix tests --budget 100k
```

### Plugin-level defaults

Pass options when registering the plugin to change the defaults for all goals. To combine with the `goal` command, merge this plugin entry into the config shown above.

```json
{
  "plugin": [
    [
      "opencode-goal-plugin",
      {
        "maxTurns": 10,
        "maxDurationMs": 900000,
        "maxTokens": 200000,
        "minDelayMs": 1500,
        "maxRecentMessages": 50,
        "noProgressTokenThreshold": 50,
        "noProgressTurnsBeforePause": 2,
        "noToolCallTurnsBeforePause": 2,
        "budgetWrapupRatio": 0.8,
        "maxPromptFailures": 3,
        "persistState": true,
        "stateFilePath": ".opencode/goals/state.json",
        "resultRetentionMs": 604800000,
        "maxStoredResults": 200
      }
    ]
  ]
}
```

Additional plugin-level options:

- `maxRecentMessages` — how many recent session messages to scan when looking for the latest assistant turn before auto-continuing. Higher values make long, tool-heavy sessions less likely to lose the most recent assistant response.
- `noProgressTurnsBeforePause` — grace window for low-output stalls. The plugin pauses only after this many consecutive stalled low-output turns rather than on the first one.
- `noToolCallTurnsBeforePause` — grace window for tool-free continuation turns. The plugin pauses after this many consecutive continuation turns that produced no tool calls (anti self-chat loop). Default `2`.
- `warnTurnsRemaining` / `warnDurationMsRemaining` / `warnTokensRemaining` — thresholds at which the auto-continue prompt appends a "limits are near" warning (default `3` turns, `60000` ms, `25000` context tokens). Lower them to warn closer to the limit, or raise them to warn earlier.
- `commandName` — the slash command the plugin owns (default `goal`). Set it to e.g. `objective` to drive the workflow with `/objective` instead of `/goal`; a leading slash is tolerated. Remember to register the matching command name in your OpenCode `command` config. User-facing hints (`/goal status`, `/goal resume`, …) follow the configured name.
- `registerCommand` — whether the plugin installs its `command.execute.before` hook at all (default `true`). Set it to `false` if you only want the auto-continue/persistence behavior driven programmatically and don't want the plugin to own a slash command.
- `registerTools` — whether the plugin registers the agent-facing goal tools (default `true`). Requires the optional `@opencode-ai/plugin` peer dependency to be present; when it is absent, tool registration is skipped and the command/event hooks still work. Set to `false` to omit the programmatic tool surface entirely. See [Agent tools](#agent-tools-optional).
- `persistState` — whether to persist active goals and recent goal results to disk.
- `stateFilePath` — where the persisted state JSON is written. Overrides the default project-local path and the `OPENCODE_GOAL_STATE_PATH` env var. Useful if you want a fixed or ephemeral location. When unset, the default is `<cwd>/.opencode/goals/state.json` (see the persistence section above), and `OPENCODE_GOAL_STATE_PATH` can override it without editing config.
- `resultRetentionMs` — how long a completed goal summary remains available through `/goal status` after the goal leaves active memory.
- `maxStoredResults` — maximum number of completed-goal summaries retained in process memory before the oldest ones are evicted.

## Agent tools (optional)

In addition to the `/goal` command, the plugin can expose the same workflow to the model as callable tools, so the agent can inspect and manage the goal itself. This requires the optional `@opencode-ai/plugin` peer dependency (it provides the `tool` helper and schema). When that package isn't installed the tools are simply not registered and everything else keeps working. Disable them explicitly with `registerTools: false`.

Registered tools:

- `get_goal` — current goal status (objective, budget usage, latest checkpoint).
- `get_goal_history` — lifecycle history and latest checkpoint.
- `set_goal` — set/replace the session goal. Its description constrains the agent to call it **only when the user explicitly asks** to set a goal. Accepts `objective` plus optional `maxTurns`, `maxTokens`, `maxDurationMs`, `successCriteria`, `constraints`, and `mode`.
- `update_goal` — revise the `objective` and/or set `status` to `complete` / `blocked` / `paused` / `resumed` (with `evidence` for complete or `blocker` for blocked).
- `clear_goal` — clear the current goal and discard its saved status.

These operate on the same per-session multi-goal state as the command path: a tool-set goal persists, shows up in `/goal list`, and is driven by the idle auto-continue; completing a goal in an ordered (sisyphus) sequence auto-promotes the next.

> Integration note: the tool execute-context shape (`ctx.sessionID`) and the `tool.schema` surface follow the OpenCode plugin docs. The tool **logic** is unit-tested independently, but the live registration should be confirmed against a real OpenCode run (see the smoke-test checklist).

## Audit messages

When the assistant marks a goal complete or blocked, the plugin announces the audit instead of doing it silently: an audit-start message ("Auditing goal completion…") and an audit-result message ("completion accepted — goal archived" / "paused as blocked — …"). By default these are delivered through OpenCode's structured log (`client.app.log`, visible to the user). Provide an `auditMessenger(sessionID, text)` plugin option to route them elsewhere (for example into the live conversation once a suitable message API is available), or set `auditMessages: false` to disable them.
## Completion auditor (optional)

By default a `[goal:complete]` is accepted on the assistant's word. You can require an independent audit before a goal is archived:

- `completionAudit: true` — the plugin spawns an independent OpenCode child session to verify the completion against the goal and workspace. The auditor replies with `[audit:approved]` or `[audit:rejected]` (with a reason).
- `auditor: async ({ goal, sessionID, latestText }) => ({ approved, reason })` — supply your own auditor function (takes precedence over `completionAudit`).

On **approval** the goal is archived as achieved. On **rejection** the goal is *not* archived — it is paused with stop reason `audit rejected` and the reason in its status, so you can address the gap and `/goal resume`. The built-in child-session auditor fails *open* (auto-approves) if the session API is unavailable, while a custom auditor that throws is treated as a rejection (fail closed). The audit is off unless one of these options is set.

Pass `auditorOptions` to tune the built-in auditor:

```js
GoalPlugin({
  completionAudit: true,
  auditorOptions: {
    timeoutMs: 60_000,  // default 120 000 ms; set lower for faster CI feedback
  },
})
```

`timeoutMs` caps how long the built-in child-session auditor waits for a verdict. If the session doesn't reply within the timeout the auditor auto-approves (fail open) so the goal can still be archived. `auditorOptions` is ignored when a custom `auditor` function is supplied.

## Prompt safety

The goal text is wrapped in `<goal_objective>` tags and labeled as user-provided task data. The assistant is told to treat it as a task description, not as elevated instructions that can override system, developer, tool, or repository policies.

## Limitations

This is a marker-based implementation. The assistant is responsible for outputting `[goal:complete]` or `[goal:blocked]` — there is no independent evaluator verifying completion against the original goal. Claude Code's native `/goal` uses a separate evaluator model; this plugin currently approximates the workflow using OpenCode hooks and explicit completion markers. A future version could add a separate evaluator once OpenCode exposes a clean plugin API for that flow.

OpenCode's current `command.execute.before` hook does not fully intercept command text. The plugin can update in-memory goal state as a side effect, but the goal text may still be routed into the normal assistant conversation alongside the state update.

The plugin depends on `experimental.chat.system.transform` and other OpenCode plugin hooks that may change between OpenCode versions.

## Local development

Point OpenCode at the source file directly for local testing:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-goal-plugin/src/goal-plugin.js"]
}
```

Keep test files outside OpenCode's auto-loaded plugin directory — OpenCode will attempt to load plugin-like files it finds there.

### Smoke-test checklist

1. Run `npm run smoke` to verify the package export path and `/goal` command hook without a model call.
2. Install or file-load the plugin in a temporary OpenCode config.
3. Add a `goal` command with `"template": "$ARGUMENTS"`.
4. Run `/goal status` — should report no active goal.
5. Run `/goal inspect this repo and stop immediately with [goal:blocked] if you need user input`.
6. Verify `/goal status`, `/goal pause`, `/goal resume`, and `/goal clear` behave as expected.
7. If you changed hook payload handling or command behavior, repeat the smoke test against the exact OpenCode version and provider/backend combination you care about.

## Development

```sh
npm test                # run the test suite
npm run test:coverage   # run tests with coverage
npm run smoke           # verify package export + command hook without a model call
npm run check           # syntax check + tests
npm run pack:check      # verify package contents before publishing
```

## License

MIT
