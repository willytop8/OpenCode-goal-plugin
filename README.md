# opencode-goal-plugin

[![npm version](https://img.shields.io/npm/v/opencode-goal-plugin)](https://www.npmjs.com/package/opencode-goal-plugin)
[![npm downloads](https://img.shields.io/npm/dm/opencode-goal-plugin)](https://www.npmjs.com/package/opencode-goal-plugin)
[![CI](https://github.com/willytop8/OpenCode-goal-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/willytop8/OpenCode-goal-plugin/actions/workflows/ci.yml)
[![CodeQL](https://github.com/willytop8/OpenCode-goal-plugin/actions/workflows/codeql.yml/badge.svg)](https://github.com/willytop8/OpenCode-goal-plugin/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A session-scoped `/goal` workflow for [OpenCode](https://opencode.ai/).

Set a goal and the plugin keeps it in context, auto-continues the session whenever the assistant goes idle, and stops when the goal is marked complete, a blocker is reported, or a safety limit is reached.

Compatibility: this plugin relies on experimental OpenCode hooks. Re-test against the exact OpenCode build and provider/backend stack you plan to use for unattended work.

## What it provides

- Session-scoped goals that remain visible across turns and compaction.
- Guarded auto-continuation with turn, duration, token, no-progress, and no-tool-call limits.
- Project-local restart recovery backed by persisted state and a bounded lifecycle ledger.
- Evidence-gated completion with an optional independent, fail-closed verifier.
- Explicit `active`, `paused`, and `blocked` status plus transition-only lifecycle notices.
- Canonical agent tools, collision-safe goal/verifier agents, multiple goals, and ordered goal sequences.

This project is independently implemented for OpenCode. Product names used elsewhere identify their respective owners; no feature-parity or endorsement claim is implied.

## Compatibility snapshot

| Surface | Status |
|---|---|
| Node.js | Declared support: `>=18`; CI covers Node 18, 20, 22, and 24 |
| Operating systems | Filesystem-sensitive lifecycle tests run on Linux, macOS, and Windows |
| Package entrypoint | Installed-tarball contracts verify both export paths, consumer TypeScript resolution, hooks, and all 11 tools |
| Provider/backend quirks | Strict-template backends require the goal block to merge into the primary `system` message; covered by regression tests |

See the [compatibility policy](docs/compatibility.md) for the supported public
surface and versioning expectations.

### OpenCode version compatibility

Tested against real OpenCode 1.17.15 processes with live provider credentials and no mocked plugin hooks. State, ledger entries, and workspace files were checked independently of terminal or model prose:

| OpenCode Version | Provider Tested | `/goal status` | Auto-continue | Evidence-gated completion | Historical custom-command presentation (v0.6.6) |
|---|---|---|---|---|---|
| 1.17.15 | opencode (`deepseek-v4-flash-free`) | ✅ Canonical tool | ✅ Checkpoint + idle continuation | ✅ Structured `goal_complete` claim | ⚠️ Command text routed to model; mutation guard verified |
| 1.17.15 | opencode-go (`qwen3.7-plus`) | ✅ | ✅ | ✅ Self-corrected after one rejection (bare `[goal:complete]` with no evidence), then completed cleanly | ⚠️ Not displayed |
| 1.17.15 | opencode-go (`glm-5.2`) | ✅ | ✅ | ✅ Clean `[goal:evidence]` + `[goal:complete]` on the first attempt | ⚠️ Not displayed |
| 1.17.15 | deepseek (`deepseek-chat`) | ✅ | ✅ | ✅ Clean `[goal:evidence]` + `[goal:complete]` on the first attempt; also verified end-to-end via the [demo](demo/) — autonomously fixed a real bug and reported evidence-backed completion | ⚠️ Not displayed |

`/goal status` and auto-continue are graded on **state correctness** (verified directly against persisted state: correct limits, turn/stop accounting, completion state, and file effects), not on terminal rendering. The `deepseek-v4-flash-free` canary suite additionally covers pause/resume across processes, blocker/restart, hard-process recovery, real host compaction, and stale-history clear enforcement. See [`docs/providers.md`](docs/providers.md) for the complete lifecycle matrix and session evidence.

**Note:** The table records the v0.6.6 live-provider matrix. In that release, OpenCode 1.17.15 retained the original command-parts array, so assigning a new `output.parts` array did not replace the raw command argument sent to the model. The current implementation mutates that retained array in place, making the plugin-generated command result the prompt for the turn. OpenCode custom commands still run through the model rather than rendering hook output directly, so the visible response may summarize or paraphrase the result (see [Limitations](#limitations)). Re-test against the exact OpenCode build and provider/backend stack you rely on for unattended work, and see [`docs/providers.md`](docs/providers.md) for the full historical model matrix.

Separately, the lifecycle-feedback implementation included in v0.7.0 passed a real OpenCode 1.18.11 host canary covering create, status, pause, resume, edit, and default lifecycle logging with a deterministic localhost provider. That canary validates host integration, not another live-provider compatibility row.

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

`--success` (alias `--success-criteria`) and `--constraints` (alias `--non-goals`) take quoted text and are injected alongside the objective so the assistant keeps them in view. `--mode` is `normal` (default) or `ordered`; `ordered` tells the assistant to preserve step order inside one objective. To queue distinct objectives that auto-promote one at a time, use `/goal sequence`. Multi-word values must be quoted.

Flags accept either `--flag value` or `--flag=value`. If a flag is unknown, missing a value, given a non-positive integer, or (for `--mode`) an unrecognized mode, the plugin rejects the command with a helpful error instead of silently folding the bad flag into the goal text.

Check status:

```
/goal status
```

`/goal status` keeps its existing `Active goal:` heading and adds an explicit `State:` line: `active` while the goal can continue, `blocked` when the assistant recorded a concrete blocker, and `paused` for other retained stops such as user intervention, a safety limit, or an audit rejection. A `Completion audit:` line distinguishes the always-on evidence gate from an optional built-in independent verifier or custom completion auditor.

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

Clear all live goals in the current session and discard their saved status:

```
/goal clear
```

`/goal stop`, `/goal off`, `/goal reset`, `/goal none`, and `/goal cancel` are aliases for `/goal clear`.

### Session forks and child sessions

Goals are scoped to the session where they were created. A child session or a
fork does not automatically inherit its parent's active goal; set a goal in the
new session when you want it to continue independently.

This isolation is intentional. OpenCode currently includes `parentID` for
ordinary child sessions but does not expose the source session in the
`session.created` event for forks. Inferring ancestry from a mutable title such
as `(fork #1)` could attach a goal to the wrong session. Automatic inheritance
can be added once the host exposes an explicit fork relationship.

### Multiple goals

A session can hold more than one goal. `/goal <condition>` replaces the focused goal, while `/goal add <condition>` keeps the current goal (backgrounding it) and focuses a new one. Only the **focused** goal is auto-continued; backgrounded goals are paused until you focus them.

```
/goal add write the migration guide
/goal list
/goal focus 1
```

`/goal list` shows numbered live goals (focused and backgrounded) plus achieved goals retained in the per-session archive. Each live entry includes its explicit `active`, `paused`, or `blocked` state; a stopped focused goal keeps its bounded stop or blocker reason visible. `/goal clear` intentionally removes live goals and saved status from these views; its terminal ledger entries remain available for crash-safe recovery decisions. `/goal focus <number>` switches the active goal, backgrounding the previous one. Focus is tracked per session and survives a restart.

#### Ordered sequences

`/goal sequence` sets up a strict execution queue: separate objectives with `;` or newlines, and the plugin runs them one at a time, focusing the next as soon as the current one completes.

```
/goal sequence build the parser; write the tests; ship the release
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
/goal sequence build the parser; write the tests; ship the release
```

## How it works

1. When you set a goal, the plugin stores it in per-session state and replaces the custom-command turn with a plugin-generated work instruction containing that objective. On hosts that invoke `experimental.chat.system.transform`, it also reinforces the active goal in the system prompt; command correctness does not rely on that experimental hook.
2. Each time the session goes idle, the plugin sends a continuation prompt containing the remaining budget and completion audit while the original goal remains in conversation history. Continuations retain the agent, provider/model, and variant that initiated the goal. Before sending after a cooldown, the plugin re-checks that the session is still idle and no human message, newer assistant turn, Plan-agent switch, rejected permission, abort, or provider error has superseded the request.
3. The plugin stops auto-continuing when the assistant ends a response with a substantiated `[goal:complete]` or `[goal:blocked]`, or when a safety limit is reached. A `[goal:complete]` is only honored when it is preceded by a `[goal:evidence]` line; a `[goal:blocked]` is only honored when a concrete blocker is stated. Unsubstantiated claims are rejected and the plugin re-prompts for the missing evidence or blocker.
4. If OpenCode compacts the session, the plugin injects a deterministic summary into the compaction context so the goal survives the compaction and the assistant keeps the thread. The summary — objective, status, budget usage, recent checkpoints, and recent lifecycle events — is reconstructed from the plugin's persisted goal record rather than from chat memory, so it is stable and reproducible. While a goal is active, the plugin also disables OpenCode's generic post-compaction auto-continue so it does not race the plugin's own continuation.
5. If you send a message of your own while the goal is running, the plugin treats it as the latest instruction, pauses auto-continue, and asks OpenCode to abort an already accepted continuation so it does not talk over you. The plugin's own continuation prompts are ignored for this check (they are not "your" messages). A durable claim on the source assistant turn also prevents different idle event IDs from sending the same continuation twice. Run `/goal resume` to hand control back to the goal loop.

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

`[goal:complete]` — goal is satisfied. It is **only honored when the immediately adjacent evidence line begins with `[goal:evidence]` and contains a non-empty summary** of what was verified (commands run and their results, files checked). The historical two-line form (`[goal:evidence]`, then one evidence line) is also accepted. A stale or non-adjacent evidence marker is rejected. The accepted evidence is shown in `/goal status` after completion.
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

**Effective turn count.** Each LLM turn on a real task typically takes 30–90 seconds. The default 10 auto-continues is normally the binding brake before the 15-minute window; raise `--max-turns` and/or `--max-minutes` deliberately for longer work.

**Token budget.** The plugin tracks the session's context window size (`input + output + reasoning` tokens on the latest message). This matches the token count that OpenCode displays, so the numbers should be consistent. When the context window reaches the `--max-tokens` limit, the plugin sends a wrap-up prompt and stops. In high-context sessions (large codebases, long conversation history), the context can grow quickly — treat the budget as a safety brake.

**No-progress heuristic.** A low-output turn does not pause immediately anymore. The plugin pauses only after `noProgressTurnsBeforePause` consecutive *stalled* low-output turns — repeated turns with very little output and no meaningful change in the latest assistant checkpoint.

**No-tool-call heuristic.** Complementing the no-progress check, the plugin also watches for continuation turns that produce no tool calls at all (a "talk only" turn). Repeated talk-only turns usually mean the assistant is chatting to itself rather than doing work, so after `noToolCallTurnsBeforePause` consecutive tool-free continuation turns the plugin pauses. A turn that uses any tool (or delegates a subtask) resets the counter.

**Wrap-up vs. hard stop.** When a limit is reached, the plugin sends one final prompt asking the assistant to summarize what is done, what remains, and the next concrete step — rather than stopping silently. Use `/goal resume` to continue after any stop, including limit stops and no-progress pauses.

Goal state is persisted by default to a **project-local** namespace rooted at `.opencode/goals/state.json` relative to the working directory, so goals follow the project rather than your home directory. Each OpenCode session gets a separate hashed shard at `<stateFilePath>.sessions/<sha256(sessionID)>/state.json`, allowing unrelated sessions in the same project to run concurrently. The state is local and is not synchronized across machines. You may want to add `.opencode/goals/` to your `.gitignore`.

The state-file location is resolved with this precedence:

1. the `stateFilePath` plugin option, if set;
2. the `OPENCODE_GOAL_STATE_PATH` environment variable, if set;
3. the project-local default `<cwd>/.opencode/goals/state.json`.

When a project has no shard namespace yet, the plugin migrates all sessions from older locations on first session access: the legacy `~/.opencode-goal-plugin/state.json` and the XDG path `${XDG_STATE_HOME:-~/.local/state}/opencode-goal-plugin/state.json`. Migration is exclusively claimed; after every session shard is written, the source files are retired to timestamped `.migrated…` backups so another project cannot import the same private goal state. An explicit `stateFilePath` or `OPENCODE_GOAL_STATE_PATH` is used as the shard namespace root and has no migration fallback.

The state directory is created with owner-only permissions, and the JSON state file is written as `0600` because it may contain goal text, assistant checkpoints, and workflow history.

Alongside each session shard the plugin keeps an **append-only lifecycle ledger** (`<shard>/state.json.ledger.jsonl`, also `0600`). Every lifecycle event — set, edit, auto-continue, pause, resume, blocked, completed, limit — is appended as one JSON line. Because the in-memory history is capped, the ledger is the durable record: if a session state file is missing or corrupted, the plugin reconstructs still-active (non-completed) goals from that session's ledger on startup and reloads them in the paused recovery state. Terminal events (complete/blocked) are written to the ledger *before* the state write, so a goal's terminal outcome survives even if that write fails (**fail-closed**); such a failure is logged at error level.

Recovered active goals are loaded in a **paused** state with a recovery note, so unattended auto-continue does not resume blindly after a restart. Set `"persistState": false` to keep purely in-memory behavior (this also disables the ledger).

Only one OpenCode process may own a given session shard at a time. If the same session is opened in a second process, that process enters **passive goal mode** instead of failing the whole session: ordinary chat and unrelated tools continue to work, but `/goal` commands and goal tools report that another process owns the workflow. Canonical goal tools return the stable envelope code `error: "session_owned_elsewhere"`. The passive process does not read, mutate, persist, or auto-continue that session's goal state. After the owner exits, retry an explicit goal command or goal tool; the process will acquire the shard and load any recovered active goal paused. To work concurrently without waiting, create a new session with `opencode --continue --fork` (or `opencode --session <id> --fork`).

Lease ownership uses immutable per-process claim files so a delayed stale-lock cleanup or duplicate release cannot delete a newer owner's lease. The plugin publishes a complete regular-file compatibility guard atomically at `<shard>/state.json.lock`, then elects the current owner from claims in the sibling `<shard>/state.json.lock.claims-v2/` directory. That no-replace publication makes startup safe against older releases: either the older lock directory wins and the current plugin stays passive, or the guard file wins and the older release cannot reclaim it. Automatic ownership handoff requires the current release. Legacy, incomplete, tampered, or unsupported lease layouts fail closed instead of being rewritten online; filesystems must support regular-file hard links and preserve the guard's future timestamp. After confirming that every process using the session is closed and upgraded, either fork or remove only the affected shard's adjacent `.lock` file or legacy directory **and** `.lock.claims-v2` directory; keep its state and ledger.

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
| `--mode <normal\|ordered>` | Prompt mode for one goal; `ordered` preserves step order inside its objective |
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
- `noToolCallTurnsBeforePause` — grace window for tool-free continuation turns. The plugin pauses after this many consecutive continuation turns that produced no tool calls (anti self-chat loop). Default `2`; set the plugin option to `0` for legitimate tool-free writing/research workflows.
- `noInterruptOnUserMessage` — when `true`, a new human message no longer pauses an active goal ("user intervention"); the goal loop keeps running and the message steers the next continuation. Because typing a message no longer stops the loop, `/goal pause` and `/goal stop` become the way to halt it. Default `false`, which pauses for `/goal resume` as before.
- `noContinueWhileChildrenActive` — when `true`, auto-continue is deferred while the session has active child sessions (subagents, background tasks): the goal stays running but does not prompt the orchestrator until the children finish. A child counts as active only while the host reports a non-idle status for it, and each deferral is reported in `/goal status` and the lifecycle history so a waiting goal is never mistaken for a hung one. Default `false`. Enabling it adds a `children` and a `status` call to each idle the goal loop evaluates. The gate fails open — continuation proceeds — for hosts that cannot report children/status, for sessions with more concurrent children than the plugin can track, and for children that run goals of their own. Note that the gate relies on the child's own idle event to resume, so a host that never emits one leaves the goal waiting; `/goal status` reports the deferral in that case.
- `warnTurnsRemaining` / `warnDurationMsRemaining` / `warnTokensRemaining` — thresholds at which the auto-continue prompt appends a "limits are near" warning (default `3` turns, `60000` ms, `25000` context tokens). Lower them to warn closer to the limit, or raise them to warn earlier.
- `commandName` — the slash command the plugin owns (default `goal`). Set it to e.g. `objective` to drive the workflow with `/objective` instead of `/goal`; a leading slash is tolerated. Remember to register the matching command name in your OpenCode `command` config. User-facing hints (`/goal status`, `/goal resume`, …) follow the configured name.
- `registerCommand` — whether the plugin installs its `command.execute.before` hook at all (default `true`). Set it to `false` if you only want the auto-continue/persistence behavior driven programmatically and don't want the plugin to own a slash command.
- `registerTools` — whether the plugin registers the agent-facing goal tools (default `true`). Set to `false` to omit the programmatic tool surface entirely. See [Agent tools](#agent-tools).
- `registerAgents` — whether the config hook adds native `goal` and `goal-verify` agents (default `true`). Existing agents with those names are preserved unchanged; the plugin never changes your default agent.
- `goalAgentName` / `verifierAgentName` — customize the registered native agent names (defaults `goal` and `goal-verify`). The verifier is a hidden subagent with a default-deny tool policy; only `read`, `glob`, and `grep` are allowed.
- `sdkShape` — OpenCode session-client argument shape: `legacy` (the default generated `PluginInput` client using `{ path, body, query }`) or `flat` (clients using `{ sessionID, ... }`). Read-only `messages`/`get` calls may probe the alternate shape after an argument/schema `TypeError`; mutating calls are never replayed, so set this option correctly for embedded clients.
- `persistState` — whether to persist active goals and recent goal results to disk.
- `stateFilePath` — root path for the persisted session-shard namespace. Overrides the default project-local path and the `OPENCODE_GOAL_STATE_PATH` env var. Useful if you want a fixed or ephemeral location. When unset, the default root is `<cwd>/.opencode/goals/state.json`; shards are written below `<stateFilePath>.sessions/` (see the persistence section above).
- `ledgerMaxBytes` / `ledgerRetentionFiles` — bound the lifecycle ledger to 2 MiB per generation and three rotated generations by default. Set retention to `0` to discard the active ledger when it reaches the size ceiling.
- `resultRetentionMs` — how long a completed goal summary remains available through `/goal status` after the goal leaves active memory.
- `maxStoredResults` — maximum number of completed-goal summaries retained in process memory before the oldest ones are evicted.
- `lifecycleMessages` — announce applied goal-state transitions (default `true`). Set to `false` to disable lifecycle notices without disabling audit messages or persistence.
- `lifecycleMessenger(sessionID, text)` — route lifecycle notices to a custom sink instead of the default structured-log/TUI-toast path.

## Agent tools

In addition to the `/goal` command, the plugin registers the same workflow as callable model tools by default, so the agent can inspect and manage the goal itself. A normal `opencode-goal-plugin` install includes the schema dependency needed for these definitions; no separate OpenCode helper package is required. Disable the tool surface explicitly with `registerTools: false`.

Registered tools:

- `goal_status`, `goal_set`, `goal_pause`, `goal_resume`, `goal_block`, and `goal_complete` are the canonical narrow operations. They return compact versioned JSON envelopes so agents can branch reliably without parsing prose.
- `get_goal`, `get_goal_history`, `set_goal`, `update_goal`, and `clear_goal` remain compatibility aliases with their existing text responses.

`goal_set` and `set_goal` are explicitly constrained to user-requested goals. `goal_complete` accepts a structured claim: a required non-empty `summary`, plus optional criterion/evidence pairs, checks (`passed`, `failed`, or `not-run`), changed files, and known limitations. Failed checks and empty criterion evidence are rejected before archival; accepted claims are serialized deterministically for the configured completion auditor. The legacy `update_goal` tool retains its string `evidence` field for compatibility.

These operate on the same per-session multi-goal state as the command path: a tool-set goal persists, shows up in `/goal list`, and is driven by the idle auto-continue; completing a goal in an ordered sequence auto-promotes the next.

> Integration note: the tool execute-context shape (`ctx.sessionID`) and Zod argument definitions follow the OpenCode plugin docs. The tool **logic** is unit-tested independently, but live registration should still be confirmed against the exact OpenCode host used in production (see the smoke-test checklist).

## Lifecycle messages

The plugin announces meaningful, applied state transitions such as goal creation, focus changes, pause/resume, recovery, ordered-goal promotion, and clearing. It does not emit a notice for every idle event, checkpoint, or continuation attempt. Messages are bounded and avoid dumping the full objective, evidence, or filesystem paths.

By default, lifecycle notices go to OpenCode's structured log and to a TUI toast when that host capability is available. Provide a `lifecycleMessenger(sessionID, text)` plugin option to route them elsewhere, or set `lifecycleMessages: false` to disable them. Delivery is advisory: notices do not start an assistant turn or make any extra model call, and a log, toast, or custom-messenger failure does not undo the recorded state transition.

Lifecycle notices and audit messages are separate controls. Lifecycle notices describe applied goal state; audit messages describe completion/block validation. When `auditMessages` is `true`, its audit-result message is the sole completion/block announcement. When `auditMessages` is `false` and `lifecycleMessages` is `true`, the lifecycle channel emits one terminal fallback instead. Other transitions follow `lifecycleMessages`; disabling one control does not disable the other.

## Audit messages

When the assistant marks a goal complete or blocked, the plugin announces the audit instead of doing it silently: an audit-start message ("Auditing goal completion…") and an audit-result message ("completion accepted — goal archived" / "paused as blocked — …"). By default these are written to OpenCode's structured log and shown as a TUI toast when that client capability is available. Provide an `auditMessenger(sessionID, text)` plugin option to route them elsewhere, or set `auditMessages: false` to disable them. The audit-result message owns the terminal completion/block announcement while `auditMessages` is enabled, so the lifecycle channel does not duplicate it.

Audit messages are visibility only; enabling them does not turn on the independent completion auditor. The evidence gate always applies. Independent verification is enabled only with `completionAudit: true` or a custom `auditor`.

## Completion auditor (optional)

Every `[goal:complete]` claim must first pass the local evidence gate described above. By default, that evidence gate is the only verifier. You can additionally require an independent audit before a goal is archived:

- `completionAudit: true` — the plugin spawns an independent OpenCode child session to verify the completion against the goal and workspace. The auditor replies with `[audit:approved]` or `[audit:rejected]` (with a reason).
- `auditor: async ({ goal, sessionID, latestText }) => ({ approved, reason })` — supply your own auditor function (takes precedence over `completionAudit`).

On **approval** the goal is archived as achieved. On **rejection** the goal is *not* archived — it is paused with stop reason `audit rejected` and the reason in its status, so you can address the gap and `/goal resume`. The built-in and custom auditors fail closed by default. The audit is off unless one of these options is set.

Pass `auditorOptions` to tune the built-in auditor:

```js
await GoalPlugin(
  { client },
  {
    completionAudit: true,
    auditorOptions: {
      timeoutMs: 60_000,  // default 120 000 ms; set lower for faster CI feedback
      failurePolicy: "reject",
    },
  },
)
```

`timeoutMs` caps how long the built-in child-session auditor waits for a verdict. `failurePolicy` defaults to `reject`: an unavailable API, missing child-session ID, provider error, or timeout rejects the audit and pauses the goal for review. Set it to `approve` only as an explicit compatibility escape hatch; an actual negative or malformed verifier verdict still rejects. `auditorOptions` is ignored when a custom `auditor` function is supplied.

## Prompt safety

The goal text is wrapped in `<goal_objective>` tags and labeled as user-provided task data. The assistant is told to treat it as a task description, not as elevated instructions that can override system, developer, tool, or repository policies.

## Limitations

The assistant still signals candidate outcomes with `[goal:complete]` or `[goal:blocked]`. Completion can additionally be checked by a custom `auditor` callback or the built-in child-session auditor before the goal becomes terminal. Marker quality therefore remains model-dependent when auditing is disabled, and audit quality depends on the configured verifier model and evidence available in the session. The built-in verifier performs static inspection with `read`, `glob`, and `grep`; it cannot execute shell commands.

OpenCode custom commands are prompts, not direct plugin-rendered TUI responses. After `command.execute.before` runs, OpenCode sends its retained command-parts array through a normal model turn. The plugin mutates that array in place so the model receives the deterministic plugin-generated result instead of the raw `/goal` argument. The model still produces the visible response and may summarize or paraphrase that result.

Objective-bearing commands preserve file attachments. OpenCode may expand those files into synthetic Read/MCP text and file parts before `chat.message`; the plugin accepts that expansion only when it matches the one-shot command correlation, retained-file count, and generated message/session identity. Other mixed text is treated as a new human instruction and pauses an active loop. If OpenCode reports an attachment-read error during that expansion, the goal pauses with `attachment resolution error` while retaining the correct command provenance.

For `/goal status`, `/goal history`, `/goal list`, `/goal pause`, and `/goal clear` (including aliases), the rewritten user turn carries an escaped control-result envelope with direct instructions to report the supplied data without treating it as new work. `tool.execute.before` rejects every tool call for that reporting turn, and the parent-correlated assistant response is excluded from checkpoint, completion, blocker, and stall analysis. These protections do not depend on the model following the reporting instruction.

The plugin still registers `experimental.chat.system.transform` as defense in depth for hosts that invoke it. Real OpenCode 1.17.15 and 1.18.10 do not call that hook, so the command-control protections above are deliberately self-contained. Other OpenCode plugin hooks may change between versions.

Distinct OpenCode sessions may own shards under the same `stateFilePath` concurrently. A second process using the same session shard remains usable in passive goal mode, but goal commands and tools are denied until it can acquire that shard. The passive process never falls back to an unpersisted copy of the same goal workflow, which avoids divergent state and last-writer-wins data loss. Use the owner, wait and retry an explicit goal control after it exits, or fork to a new session. A no-replace compatibility guard prevents an older release and the current release from both acquiring during startup; current immutable claims protect takeover and release among upgraded processes. Older processes cannot take over a guarded shard, so all processes participating in automatic same-session handoff must run the current release.

## Diagnostics and recovery

Start with `/goal status`, then `/goal history`. Together they show whether a goal is active, its stop reason and budget usage, and the recent lifecycle/checkpoint trail without exposing the entire on-disk ledger to the model.

If a goal does not continue:

1. Check for a deliberate pause: user intervention, a hard limit, repeated tool-free/no-progress turns, prompt failures, or a rejected completion audit all stop unattended work by design.
2. Run `/goal resume` only after resolving the reported reason. Resume creates a fresh local budget window; it does not erase the objective or history.
3. If a goal control reports that another process owns the session, close that owner and retry the control, or fork to a new session. If it instead reports an older, incomplete, tampered, or unsupported lease, close every process that could own the session and upgrade them first; if the report persists, remove only the affected shard's adjacent `.lock` file or legacy directory and `.lock.claims-v2` directory, or fork. Keep the state and ledger. Do not point two copies of the same session at different state paths: that creates divergent goal histories.
4. Check OpenCode's structured logs for persistence, SDK-shape, prompt, or auditor errors.
5. Confirm the configured project directory and state-path precedence described under [Safety limits](#safety-limits). A daemon started elsewhere can otherwise make a manually configured relative path surprising.
6. Run `npm run verify`, `npm run smoke`, and `npm run smoke:packed-host` against the installed source when diagnosing registration or packaging problems. Maintainers can run `npm run release:check` for the complete artifact and quality gate. `npm run benchmark:behavior` exercises completion, false-completion, loop, interruption, compaction, and restart behavior without a provider call.

Do not paste `state.json`, its ledger, or verbose logs into a public issue without reviewing them first: they can contain goal text, assistant checkpoints, blockers, local paths, and command evidence. Prefer the bounded status/history output and redact project-specific content. There is intentionally no broad "dump diagnostics" tool: exposing process-wide session state or persistence paths to the model would add more privacy risk than troubleshooting value.

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
npm run type:check      # compile installed-package consumers
npm run test:mutation   # prove critical regressions are detected
npm run smoke           # verify package export + command hook without a model call
npm run smoke:packed-host # install the packed tarball and exercise the host contract
npm run smoke:packed-tools # verify all tools from an installed tarball
npm run benchmark:behavior # deterministic autonomy + token-efficiency scenarios
npm run verify          # verify the installed plugin hook surface
npm run check           # syntax check + tests
npm run pack:check      # verify package contents before publishing
npm run release:check   # run the complete release gate
```

## License

MIT
