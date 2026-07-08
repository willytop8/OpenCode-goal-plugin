# Changelog

## Unreleased

- Add a reproducible `demo/` directory: a minimal Node project with a deliberately buggy `add()` function, a test that catches it, and an `opencode.json` wired to the local plugin source. Verified end-to-end via the OpenCode TUI.
- Scope `npm test`/`npm run test:coverage` to `test/*.test.js` explicitly, since Node's test runner otherwise recursively discovers `demo/test/*.test.js` too, which would fail the root suite whenever the demo's deliberate bug is (correctly) unfixed.
- **Fix project-local state persistence to actually use the active session's directory.** `GoalPlugin` previously ignored the `directory` field OpenCode passes in its `PluginInput`, so the default `.opencode/goals/state.json` path resolved against the Node process's own `process.cwd()` instead. This works fine for a one-shot CLI invocation, but silently breaks when OpenCode runs as a persistent server/daemon serving multiple projects: `process.cwd()` stays wherever the server booted, not the active session's project. Confirmed live via the OpenCode TUI — a goal set in a project directory never persisted to disk at all. `GoalPlugin` now reads `directory` from its `PluginInput` and uses it as the default `cwd` for state-path resolution (an explicit `cwd` plugin option, mainly for tests, still takes precedence).
- Add Node 24 to the CI matrix, a weekly scheduled CI run (Mondays 08:00 UTC) to catch upstream drift, a `test:coverage` step, and npm/CI/tests/license badges to the README.
- Add GitHub issue templates for bug reports (OpenCode version, provider/model, Node version, relevant plugin options, repro steps) and feature requests (problem solved, scope fit against the current multi-goal/audit feature set).
- Add an Examples section to the README with copy-pasteable `/goal` commands: common workflows, success criteria/constraints/budget shorthand, and an ordered (sisyphus) sequence.
- Add a Comparison section to the README benchmarking `/goal` support, auto-continue, per-goal overrides, no-progress/no-tool-call detection, safety limits, history, persistence, multi-goal/sisyphus sequences, evidence-gated completion, the optional completion auditor, budget wrap-up, and license against Claude Code and Codex.
- Add `npm run verify` / `npx opencode-goal-plugin` installation verification command (`scripts/verify.mjs`). Checks Node >= 18, the plugin module shape, that all 4 hooks (`command.execute.before`, `event`, `experimental.chat.system.transform`, `experimental.compaction.autocontinue`) register, and that `/goal status`/`/goal set` work — entirely via mock clients, with zero model calls.
- Add TypeScript declarations (`index.d.ts`) covering the full current `GoalPluginOptions` surface — budgets, persistence/ledger paths, `commandName`/`registerCommand`/`registerTools`, and the completion-audit options (`completionAudit`, `auditor`, `auditorOptions`, `auditMessages`, `auditMessenger`) — plus the plugin's hook map and default export. `package.json`'s `types` field points at it.
- Warn when `/goal <condition>` replaces the focused goal instead of silently discarding it. The response now leads with `⚠️ Replacing active goal: "<old condition>"` and points at `/goal add <condition>` as the non-destructive alternative that backgrounds the current goal instead.

## 0.4.7 — 2026-06-29

### Bug fixes (low-severity cleanups)

- **Dead `if (goal.goalId !== previousGoalId)` conditional removed from both resume paths.** `resetGoalBudget` always rotates `goalId` via `randomUUID()`, so the conditional was always `true`. The misleading branch could never be taken, masking the intent (unconditional registry re-key on resume). Both the agent-tool `updateGoal {status: "resumed"}` path and the `/goal resume` command path are now unconditional.
- **`noToolCallTurns` no longer stales on null-assistant idles.** When `messages()` returns no assistant message (only a user turn), `latestAssistant` is `null` and `latestHasToolCall` is `false`. Previously the counter incremented unconditionally; a user-only idle turn could push the goal toward a no-tool-call pause even though the model hadn't spoken. The reset condition now includes `|| !latestAssistant`, matching the intent of the stall detector.
- **`noProgressTurns` no longer stales on null-assistant idles.** Same scenario as above: when `latestOutputTokens === null` and there is no assistant message, the counter now resets instead of incrementing, consistent with the gate's purpose of detecting stalled model output.
- **Updated ledger-durability comment near `pushHistory("completed")`.** The previous comment implied the ledger was the primary recovery mechanism. The corrected comment clarifies that ledger write failures are silent (bare `catch`), and that a present state file always takes precedence over the ledger — making the ledger relevant only when the state file is absent.
- **`buildAgentToolHandlers` accepts a `persistTerminalState` option.** Terminal state transitions (`status='complete'` and `clearGoal`) now call `persistTerminalState` if provided, falling back to the regular `persist` function. The `GoalPlugin` factory passes its own `persistTerminalState` closure through, so agent-triggered completions and clears get the same durable flush semantics as the event-handler paths.

## 0.4.6 — 2026-06-29

### Bug fixes (counters, compaction, and auditor)

- **`noToolCallTurns` is now independent of `noProgressTurns`.** On a turn that qualifies for the noProgress stall gate (low output, no tool call, stalled text), the noToolCall counter no longer also increments. Without this guard, the effective grace window was `min(noProgress, noToolCall)` rather than two independent limits — a configured higher `noProgressTurnsBeforePause` threshold was silently overridden by the lower `noToolCallTurnsBeforePause`.
- **`formatFailures` is now incremented when the stall gate fires and returns early.** Stall detection previously returned before the format-failure accumulator could run. A model that repeatedly emitted bare `[goal:complete]` with low output triggered the stall gate rather than accumulating toward the `maxPromptFailures` cap; the cap was permanently unreachable because `/goal resume` reset `formatFailures` to zero each time. The counter now increments inside the stall-gate early-return path when `completionUnverified` or `blockerUnstated` is true.
- **Budget-wrapup state is persisted before the wrapup prompt is sent.** Previously `budgetWrapupSent = true` and `stopped = true` were set in memory but not persisted before `promptAsync`. A crash during the prompt would result in `budgetWrapupSent: false` in the state file and a duplicate wrapup on the next resume cycle. The fix adds `pushHistory("budget-wrapup")` + `persist()` before the prompt call, mirroring the hard-limit path.
- **`TOOL_PART_TYPES` now covers raw provider part type names.** Some OpenCode adapters forward the provider's original message part shape without normalizing to `"tool"`. Added `"tool_use"`, `"function_call"`, and `"tool-call"` to the set so `messageHasToolCall` (and both stall gates) correctly recognize tool-using turns from non-normalized adapters.
- **Approved completion that is lost while the auditor is in flight now produces an announcement.** If the goal is cleared or replaced while a completion auditor runs, and the auditor returns `approved: true`, the plugin now announces "completion was approved but the goal was modified while the audit ran — completion not recorded." Previously the approved result was silently discarded with no visible trace.
- **`buildCompactionContext` is now deterministic.** The function previously called `Date.now()` to compute elapsed seconds, so two calls during the same compaction event produced different strings, busting the prefix cache from that byte position. The elapsed time is now derived from `goal.lastContinueAt` (set during each persist cycle), making the output stable and matching the function's own claim of being "reconstructed deterministically from the plugin's persisted goal record."

## 0.4.5 — 2026-06-29

### Bug fixes (input validation + counter correctness)

- **`set_goal` now validates budget arguments and mode.** Previously `set_goal({maxTurns: 0})` silently used the global default; a typo in `mode` silently became `"normal"`. Both now return explicit errors, matching the `/goal` command's validation behavior.
- **`update_goal` cannot combine an objective update with `status='complete'` in the same call.** The completion would be archived under a condition that was never executed, falsifying the audit trail. The tool now requires two separate calls: first update the objective, then mark complete after the revised work is done.
- **`update_goal {status: 'resumed'}` on a running goal returns an error.** The slash-command path rejected this; the agent tool path silently reset all budget counters — turnCount, totalTokens, startedAt, etc. — on a goal that never stopped, enabling indefinite budget circumvention. The agent tool now rejects the call when the goal is not stopped.
- **`/goal edit` and `update_goal` objective updates now reset `formatFailures` to 0.** The edit paths already reset `noProgressTurns` and `noToolCallTurns` but omitted `formatFailures`. A goal with accumulated format-failure violations had less tolerance than a freshly-resumed goal after an objective change.
- **`/goal <condition>` replace command now clears `sessionOrdered`.** The agent `setGoal` path called `sessionOrdered.delete()` on replacement, but the slash-command path did not. A user replacing a sisyphus sequence with a standalone goal would get unexpected auto-promotion of the sequence's remaining goals after the replacement completed.
- **`set_goal` and `update_goal` tool result strings now escape XML metacharacters.** The `goal.condition` is stored raw (for use by `buildGoalBlock`/`buildContinueMessage`), but the tool result returned to the model now calls `escapeGoalText` to prevent XML metacharacters from breaking tool-result boundaries in XML-serialized formats.
- **`promptFailures` decrements by 1 on a successful prompt instead of resetting to 0.** This mirrors the `formatFailures` fix: an alternating error/success pattern previously bypassed the circuit-breaker cap indefinitely. Decrementing allows gradual recovery while still accumulating toward the cap over time.

## 0.4.4 — 2026-06-29

### Bug fixes (state machine + injection prevention)

- **`escapeGoalText` now neutralizes role-like tag openings.** The previous `STRUCTURAL_TAGS` set only covered plugin-defined tags. Tags like `<system>`, `<assistant>`, `<human>`, `<anthropic>`, `<claude>`, `<context>`, `<instructions>`, and `<prompt>` could survive unescaped in compacted system messages, creating second-order injection opportunities where model output captured by `recordCheckpoint` re-appeared as an elevated-privilege block after compaction.
- **`update_goal` objective update no longer un-stops a stopped goal.** Calling `update_goal({objective: "…"})` previously cleared `goal.stopped` and `goal.stopReason`, silently resurrecting a goal that was audit-rejected, user-paused, or blocked for any reason. Objective updates now preserve the stopped state; only an explicit `status: "resumed"` call resets it.
- **`/goal clear` and agent `clearGoal` now delete all backgrounded goals.** Previously only the focused goal was removed from the session registry (`cleanupGoal` → `removeSessionGoal`). Background goals added via `/goal add` remained alive and would promote themselves to focused on restart. Both clear paths now call `sessionGoals.delete(sessionID)` first, wiping the entire per-session goal map.
- **`formatFailures` decrements by 1 on a clean turn instead of resetting to 0.** A reset-to-zero on every non-violation turn allowed an alternating bad/good/bad pattern to bypass the consecutive-failure cap indefinitely. Decrementing by 1 means repeated violations accumulate toward the cap even when interspersed with good turns.
- **`update_goal {status: "blocked"}` requires a non-empty `blocker` argument.** The event-handler path already rejects a `[goal:blocked]` marker with no concrete blocker, but the agent tool path accepted an empty `blocker` (recording an empty `blockedReason`). The agent tool now returns an error when `blocker` is missing or whitespace-only, consistent with the auto-continue guard.

## 0.4.3 — 2026-06-29

### Bug fixes (concurrency + persistence)

- **`activeContinues` Set → Map with per-handler UUID token.** `cleanupGoal` removes the session from the Map (allowing new handlers to start), but the idle handler's `finally` block only deletes if its token still matches — preventing it from clobbering a new handler's guard. With a plain `Set`, the old `finally` unconditionally deleted the new handler's entry, creating a race window where two handlers could run concurrently for the same session.
- **Liveness re-check after `announceAudit`.** `announceAudit` is async and can yield long enough for a user to `/goal clear` or replace the goal. The handler now calls `activeGoal(sessionID, goalID)` after the announcement and returns immediately if the goal is gone, preventing an orphaned archive write.
- **`persist()` calls serialized via promise chain.** Concurrent callers previously raced on the temp-file rename: the second rename could write older state over the first. All calls now chain through `persistChain`, guaranteeing ordered writes.
- **`/goal clear` and agent `clearGoal` now emit a `"cleared"` ledger event before discarding the goal.** Without this, `reconstructGoalsFromLedger` (used when the state file is missing) would revive cleared goals as paused on restart. `LEDGER_TERMINAL_TYPES` already includes `"cleared"` — the event just wasn't being written.
- **State-file/ledger cross-check on restart.** After loading from the state file, the plugin now reads the ledger and removes any active goals whose `goalId` appears in a terminal ledger entry. This guards against the scenario where a terminal persist wrote to the ledger but the state file write failed (e.g. process killed between the two writes): the goal would otherwise load as active and be re-driven on the next idle.

### Bug fixes (state machine + security)

- **Escape checkpoint and history text in compaction context.** Checkpoint summaries and lifecycle-event details contain assistant-generated text. If a malicious assistant output included structural XML tags (e.g. `</goal_objective><budget_wrapup>…</budget_wrapup>`), they could be re-embedded unescaped in the compaction context system message. `buildCompactionProgressSummary` and the `lastCheckpoint` inline in `buildCompactionContext` now call `escapeGoalText` on all assistant-derived strings.
- **`/goal edit` and agent `update_goal` objective updates now reset `noToolCallTurns`.** The edit paths already reset `noProgressTurns` and cleared soft-stop state, but forgot `noToolCallTurns`. A goal that was heading toward a no-tool-call pause kept its stale counter after an objective change, and could pause after fewer than the configured grace turns on the new objective.
- **`formatFailures` is now preserved through a persistence round-trip.** `normalizePersistedGoal` carried `promptFailures` but omitted `formatFailures`. After a plugin restart any accumulated format-failure count was silently reset to zero, giving the model an unintended free pass on the first format re-prompts after recovery.
- **Agent `update_goal {status: "complete"}` now invokes the configured completion auditor.** The `[goal:complete]` marker path gates archival on an optional auditor, but the agent tool path bypassed it entirely. `buildAgentToolHandlers` now accepts a `completionAuditor` option, and the `GoalPlugin` factory passes the configured auditor through. A rejected verdict pauses the goal with stop reason `audit rejected`; an auditor that throws is treated as a rejection (fail closed).
- **`createChildSessionAuditor` now enforces a configurable timeout (default 120 s).** `sessionApi.prompt` could hang indefinitely, blocking the idle handler and stalling the goal forever. The auditor now races the API call against a `setTimeout` promise; if the timeout fires first, the verdict is `{ approved: false, reason: "auditor timed out after Nms" }`. The timer is always cleared after settlement.
- **Thinking-only turns are excluded from the `noProgress` stall detector.** A turn that produced reasoning tokens but no prose output and no tool calls was treated as stalled by `lowOutputLooksStalled` (prose output tokens = 0 < threshold). The new `latestHasThinkingTokens` check (`tokens.reasoning > 0`) excludes such turns from the stall gate, preventing false pauses on extended-thinking models that reason before acting.

## 0.4.2 — 2026-06-29

### Bug fixes

- **Guard against stale `message.updated` re-deliveries re-inflating `totalTokens` after `/goal resume`.** After `/goal resume`, OpenCode replays the streaming `message.updated` event for the last assistant message. Previously `resetGoalBudget` deleted those message IDs from `seenTokens`, so the replayed event looked new and added its tokens to the freshly-zeroed counter — incorrectly inflating the resumed goal's token total from the first turn. Fix: `resetGoalBudget` no longer deletes IDs from `seenTokens`. The `message.updated` handler now skips any message whose ID is already in `seenTokens` but is absent from the current `goal.messageIDs` (i.e. belongs to a prior budget epoch), so stale re-deliveries are silently ignored.
- **Guard against stale `message.updated` re-deliveries inflating a replacement goal's `totalTokens`.** When a goal is replaced via `/goal <new>`, the old goal's `cleanupGoal` path previously deleted its message IDs from `seenTokens`. If OpenCode then re-delivered a streaming event for one of those old IDs (e.g. a buffered duplicate), the new goal object had no record of it, so the guard could not fire and the event inflated the new goal's counter. Fix: `cleanupGoal` also leaves `seenTokens` entries in place. Entries accumulate across the process lifetime (O(turns × messages_per_turn)) and are cleared in bulk by `clearRuntimeState` on teardown.
- **Reset `totalTokens` to zero after session compaction.** `totalTokens` is tracked with `Math.max` semantics (peak context size), so it never decreases on its own. A goal that crossed the 80 % budget-wrapup threshold before compaction would permanently remain above it even after the context shrank to a fraction of its prior size. Fix: the `experimental.session.compacting` hook now resets `totalTokens = 0` and rotates `messageIDs` into `priorMessageIDs` after injecting the compaction context, then calls `persist()`. Post-compaction turns re-establish the token baseline from scratch.

## 0.4.1 — 2026-06-29

### Bug fixes

- **Fix provider prefix cache invalidation caused by volatile limit warnings in system prompt (#14).** `experimental.chat.system.transform` was calling `buildLimitWarning`, which appends a string containing `Date.now()`-derived `remainingMs` and a per-turn `remainingTokens` counter. Once any warning threshold was crossed (default: 25 000 tokens remaining, ≤ 3 turns left, ≤ 60 s left), the system prompt changed on every provider request — including tool-call sub-requests mid-turn — invalidating the prefix cache from byte 0 each time. On a 200 k-context thinking model consuming 20–30 k reasoning tokens/turn, this triggered O(turns × tool_calls × context_size) cache misses instead of O(1), causing the ~$12/8 min cost spike reported in issue #13. Fix: `buildLimitWarning` is removed from `system.transform`; the system prompt is now byte-stable for the full lifetime of a goal. Limit warnings continue to reach the model on every continuation turn via `buildContinueMessage`, which already included them.
- **Cap consecutive format-validation re-prompts (#15).** A model that repeatedly omitted `[goal:evidence]` on a `[goal:complete]` marker, or omitted a concrete blocker on `[goal:blocked]`, was re-prompted indefinitely: the existing `promptFailures` counter only incremented on network/protocol errors. Added a separate `formatFailures` counter that increments on each `completionUnverified` or `blockerUnstated` re-prompt and resets on a valid response. After `maxPromptFailures` consecutive format failures the goal pauses with stop reason `format validation failures` and a descriptive status message; `/goal resume` retries.
- **Exclude tool-calling turns from the noProgress stall detector (#16).** `lowOutputLooksStalled` could fire on a reasoning-heavy model doing a pure tool call (small prose output, reasoning tokens only): `latestText` is empty and `latestOutputTokens` is below the 50-token threshold, matching the stall condition. Added `!latestHasToolCall` to `lowOutputLooksStalled` so a turn that invoked any tool is never counted as stalled regardless of prose output. `latestHasToolCall` is now hoisted above both the `noProgress` and `noToolCall` blocks so both gates share the same computation.

## 0.4.0 — 2026-06-21

- **Expose agent-facing goal tools (`get_goal`, `get_goal_history`, `set_goal`, `update_goal`, `clear_goal`)** when the host provides `@opencode-ai/plugin` (a new *optional* peer dependency, loaded via a cached dynamic import so the zero-runtime-dependency posture is preserved). `set_goal` is constrained by its description to explicit user requests (so the agent does not set goals on its own); it accepts optional `maxTurns` / `maxTokens` / `maxDurationMs` overrides plus `successCriteria` / `constraints` / `mode`. `update_goal` supports objective edits and `complete` / `blocked` / `paused` / `resumed` transitions (with `evidence` / `blocker`). Tools create, replace, and clear goals through the **multi-goal registry** (the same `buildGoalState` → `registerSessionGoal` → `focusGoal` path the `/goal` command uses), so tool-created goals persist, appear in `/goal list`, and are driven by the idle handler; `complete` archives with evidence and auto-promotes the next goal in an ordered (sisyphus) sequence. Registration is skipped gracefully when the package is absent or with `registerTools: false`. New `buildAgentToolHandlers` / `buildAgentTools` / `agentToolSessionID` helpers. Implements megalist items 7.1 and 7.2. _(This is the work the 0.3.0 changelog mistakenly listed as already shipped; it is now actually implemented and adapted to the current multi-goal architecture.)_
- **Fix a goal-registry leak when resuming.** `resetGoalBudget` rotates a goal's `goalId`, but the multi-goal registry is keyed by `goalId`, so resuming and then clearing/replacing left a stale entry behind (visible in `/goal list` and persisted). Both the `/goal resume` command path and the agent `update_goal {status:"resumed"}` path now re-key the registry to the new id (the focused pointer holds the same object). Regression test added for the command path.

## 0.3.0 — 2026-06-14

> A large feature release. Stronger completion integrity (evidence gate, optional auditor, visible audit messages), durable lifecycle ledger with state reconstruction, multiple goals per session with focus and ordered sisyphus sequences, richer goal schema, more auto-continue guardrails, project-local state with migration, a deterministic compaction summary, and npm Trusted Publishing CI. All changes are additive and backward-compatible; older state files load unchanged.

### Completion integrity & audit

- **Require evidence to complete a goal and a concrete blocker to block one.** A `[goal:complete]` marker is now only honored when the assistant also supplies a non-empty `[goal:evidence] <summary>` line (on or before the completion marker); a `[goal:blocked]` is only honored when a concrete blocker is stated on the line before it. An unsubstantiated `[goal:complete]` or `[goal:blocked]` is rejected (not recorded / does not stop the goal) and the plugin sends a corrective continuation prompt demanding the missing evidence or blocker. The accepted evidence is stored on the result and shown in `/goal status` / `/goal history`. New `extractCompletionEvidence` helper, an `<evidence_required>` structural tag (added to the injection-escaping set), and continuation/system/compaction/creation prompts all updated to instruct the evidence requirement. Implements megalist item 2.1.
- **Add an optional separate completion auditor that verifies before archival.** When a completion auditor is configured, a `[goal:complete]` (with evidence) is verified before the goal is archived: on approval it archives as achieved, on rejection the goal is *restored* (paused with stop reason `audit rejected` and the reason surfaced) rather than archived. Enable the built-in auditor — which spawns an independent OpenCode child session that replies `[audit:approved]`/`[audit:rejected]` — with `completionAudit: true`, or supply a custom `auditor({ goal, sessionID, latestText }) => { approved, reason }` (takes precedence). The built-in child-session auditor fails open if the session API is unavailable; a custom auditor that throws is treated as a rejection (fail closed). New `parseAuditVerdict` / `buildAuditPrompt` / `createChildSessionAuditor` helpers. Off by default. Implements megalist item 2.2.
- **Announce completion/blocker audits with visible messages instead of silent background work.** When the assistant marks a goal complete or blocked, the plugin emits an audit-start and an audit-result message (e.g. "Auditing goal completion…" → "Audit result: completion accepted — goal archived"). Delivery defaults to OpenCode's structured log (`client.app.log`) and is pluggable via an `auditMessenger(sessionID, text)` option or disable-able with `auditMessages: false`. New `defaultAuditMessenger` helper. Implements megalist item 2.4.

### Durability

- **Add an append-only JSONL lifecycle ledger with state reconstruction, and fail-closed terminal-state persistence.** Every lifecycle event (`pushHistory`) is also appended as one JSON line to `<stateFile>.ledger.jsonl` (synchronous, owner-only `0600`). Because in-memory history is capped, the ledger is the durable record: when the main state file is missing on startup, the plugin reconstructs still-active (non-`completed`/`cleared`) goals from the ledger and reloads them paused (new `reconstructed` load status). Terminal events are written to the ledger before the main state write, so a goal's terminal outcome survives a failed state write (fail-closed); `persistState` now returns success/failure and a failed terminal persist is logged at error level. Tied to `persistState`. New `appendLedgerLine` / `readLedgerEntries` / `reconstructGoalsFromLedger` helpers. Implements megalist items 2.3 and 2.5.
- **Build the compaction summary deterministically from the persisted goal record.** `buildCompactionContext` folds in a reproducible progress summary — recent checkpoints and lifecycle events — derived from the goal's persisted `checkpoints`/`history` (new `buildCompactionProgressSummary` helper) rather than chat memory, and labels it as such. Implements megalist item 6.3.

### Auto-continue guardrails

- **Pause auto-continue on repeated tool-free continuation turns (no-tool-call gate).** Complementing the low-output no-progress check, the plugin tracks continuation turns whose assistant message has no tool calls (OpenCode `tool` / `subtask` parts) and, after `noToolCallTurnsBeforePause` consecutive such turns (default `2`), pauses with stop reason `no tool calls` to guard against self-chat loops. A tool-using turn resets the counter. Configurable via the `noToolCallTurnsBeforePause` option and `--no-tool-turns <n>` flag. New `messageHasToolCall` helper. Implements megalist item 5.1.
- **Pause auto-continue when a real user message arrives ("latest instruction wins").** The idle handler detects a genuine human message that arrived after the plugin's most recent continuation and pauses the goal (stop reason `user intervention`) instead of talking over the user; `/goal resume` hands control back. Plugin-generated continuation prompts (user-role messages framed in `<goal_continuation>`) are ignored, and detection requires `turnCount > 0` plus a visible plugin continuation so the first idle and scrolled-out sessions are never misread. New `isPluginContinuationMessage` / `userInterventionDetected` helpers. Implements megalist items 5.2 and 5.3.

### Multiple goals

- **Support multiple goals per session with `/goal add`, `/goal list`, and `/goal focus`.** A session can hold several live goals via a new `sessionGoals` registry; `goalStates` continues to track the single *focused* goal the idle handler drives. `/goal <condition>` replaces the focused goal; `/goal add <condition>` backgrounds the current goal and focuses a new one (only the focused goal auto-continues). `/goal list` shows numbered live goals plus a per-session archive of completed/cleared goals, and `/goal focus <number|id>` switches the active goal (numeric refs are index-only). Focus is tracked per session and persisted (state files gain a per-goal `focused` flag and an `archives` array; older single-goal files load with their goal focused). New `buildGoalState` / `formatGoalList` / session-registry helpers. Implements megalist items 3.1, 3.2, and 3.3.
- **Add `/goal sisyphus` ordered goal sequences.** `/goal sisyphus <obj 1>; <obj 2>; …` sets up a strict execution sequence: the first objective is focused and the rest queued, and when the focused goal completes the plugin auto-promotes the next until the sequence is exhausted. The ordered flag is tracked per session, shown in `/goal list`, persisted (`orderedSessions`), and cleared by `/goal clear`. New `promoteNextOrderedGoal` helper. Implements megalist item 3.4.

### Schema & command UX

- **Add success-criteria, constraints/non-goals, and mode to the goal schema.** A goal can carry `successCriteria` (`--success`), `constraints` (`--constraints` / `--non-goals`), and a `mode` of `normal` or `ordered` (`--mode`, `sisyphus` alias). These thread through state, persistence, the injected goal block (escaped, new `success_criteria` / `constraints` structural tags), creation output, and `/goal status`. New `normalizeMode` helper. Implements megalist items 4.1, 4.2, and 4.3.
- **Add an inline `--budget <n>` flag** on the create command — a shorthand for the context-token limit accepting a plain integer or `k`/`m` suffix (e.g. `--budget 100k`). New `parseTokenBudget` helper. Implements megalist item 8.1.
- **Make the slash command configurable (`commandName`) and optional (`registerCommand`).** `commandName` (default `goal`, leading slash tolerated) lets the plugin own e.g. `/objective`, with all user-facing hints following the configured name; `registerCommand: false` skips installing the command hook entirely. New `normalizeCommandOptions` helper. Implements megalist item 8.2.

### Storage, tools & packaging

- **Default goal state to a project-local path, with an env override and migration fallbacks.** State resolves as `stateFilePath` option → `OPENCODE_GOAL_STATE_PATH` env var → project-local `<cwd>/.opencode/goals/state.json` (previously `~/.opencode-goal-plugin/state.json`). When the default path is empty, the plugin migrates forward on first load from the legacy home path and the XDG path, then writes project-local. Explicit option/env paths are literal with no fallback; a present-but-corrupt primary is preserved. New `resolveStateFilePath` / `xdgStateFilePath` / `legacyStateFilePaths` helpers. Home-based fallback paths resolve from an injectable `env.HOME` (falling back to `os.homedir()`), making path resolution deterministic across platforms — `os.homedir()` ignores `$HOME` on macOS. Implements megalist items 6.1 and 6.2.
- _**Correction (2026-06-21):** an earlier version of this entry claimed agent-facing goal tools shipped in 0.3.0. They did not — the work was on an unmerged branch (`wr/agent-tools`) and was never included in the 0.3.0 release. The feature now actually ships; see the **Unreleased** section above. Megalist items 7.1 and 7.2._
- **Add a `Publish` GitHub Actions workflow (`.github/workflows/publish.yml`) for npm Trusted Publishing (OIDC).** On a push to `main` it runs the full check matrix on Node 18/20/22, then publishes via OIDC with no stored `NPM_TOKEN`, using a publish-on-version-change model (only publishes when `package.json`'s version is new). The publish job requires `id-token: write` and is gated behind a `release` environment. First run still requires a human to publish an initial version and configure the npm Trusted Publisher. Implements megalist item 9.1.

## 0.2.0 — 2026-06-14

- **Add `/goal edit <new objective>`.** Revise the active goal's objective in place while preserving its turn/token/time budget and lifecycle history. Any pause/blocked state is cleared and `noProgressTurns` resets so the revised goal can continue; a goal already at a hard limit re-pauses on the next idle (use `/goal resume` for a fresh budget window). Ported from prevalentWare/opencode-goal-plugin's `update_goal_objective` tool, adapted to the marker-based command model.
- **Preserve the goal across session compaction.** A new `experimental.session.compacting` hook injects the goal objective, status, budget usage, elapsed time, and latest checkpoint into the compaction context so a compaction no longer drops the goal thread mid-run. Ported from prevalentWare/opencode-goal-plugin's `compactionContext` injection.
- **Disable generic post-compaction auto-continue while a goal is active.** A new `experimental.compaction.autocontinue` hook sets `enabled = false` whenever an active (non-stopped) goal is present, so OpenCode's native post-compaction continuation does not race the plugin's own idle-triggered continuation. Paused/stopped goals leave the native behavior untouched. Ported from prevalentWare/opencode-goal-plugin.

## 0.1.14 — 2026-06-12

- **Count cached context tokens in the budget.** `totalTokensForMessage` now includes `tokens.cache.read` / `cache.write` alongside `input + output + reasoning`. On providers with prompt caching (e.g. Anthropic) most of the conversation context arrives as cache reads with a tiny `input`, so the prior estimate undercounted the context window and the token budget / wrap-up could effectively never trigger.
- **Honor `/goal pause` issued mid-handler.** The post-await re-checks in the idle handler now use a new `activeGoal` helper that treats a `stopped` goal as inactive, so a pause sent while messages are being fetched or during the cooldown no longer lets one more auto-continue slip through. Adds a regression test.
- **Harden `escapeGoalText` against forged opening tags.** In addition to escaping closing tags, the plugin now neutralizes opening forms of its own structural tags (`<budget_wrapup>`, `<next_step>`, `<completion_audit>`, `<goal_objective>`, `<goal_continuation>`, `<progress_budget>`), closing a prompt-injection path where goal text could mimic elevated-instruction blocks. Non-structural tag-like text (e.g. `<div>`) is left untouched.
- **Stop the smoke test from touching real state.** `scripts/smoke-command-hook.mjs` now runs with `persistState: false`, so `npm run smoke` can no longer read or overwrite `~/.opencode-goal-plugin/state.json`.
- Document the `warnTurnsRemaining` / `warnDurationMsRemaining` / `warnTokensRemaining` options in the README.

## 0.1.13 — 2026-06-11

> Fixes a significant token-tracking bug where the reported token count could be 5–10× higher than what OpenCode displays, making budgets appear exhausted far sooner than expected.

- **Fix token tracking to use context window size instead of cumulative API consumption.** Each `message.updated` event carries `input + output + reasoning` tokens where `input` already includes the full conversation context. Accumulating deltas across messages re-counted prior turns every time, inflating the total. The plugin now uses `Math.max` across all message updates so `totalTokens` reflects the peak context window size — matching what OpenCode reports.
- Rename `tracked_tokens_used` / `tracked_tokens_remaining` → `context_tokens_used` / `context_tokens_remaining` in continuation prompts.
- Rename `Tokens:` → `Context tokens:` in status and result displays.
- Rename `tracked token limit` / `tracked token budget` → `context token limit` / `context token budget` in all user-facing messages.
- Add regression test verifying that multi-message token tracking no longer accumulates across turns.

## 0.1.12 — 2026-06-08

- Harden `escapeGoalText` to escape all XML closing tags (`</` → `<\\/`) instead of only `</goal_objective>`, closing a prompt-injection path where user-supplied goal text could break structural framing in the continuation message.
- Add unit tests for `outputTokensForMessage`, `budgetWrapupNeeded`, `getSessionID`, `stopReason`, `normalizeOptions` boundary inputs (zero, negative, NaN, null, `budgetWrapupRatio` at 0 and 1), and `escapeGoalText` covering all structural tags.

## 0.1.11 — 2026-06-04

- Add `npm run smoke`, a package-export smoke test that exercises the `/goal` command hook without invoking a model.
- Run CI across Node 18, 20, and 22, and wire the package-entry smoke test into the workflow.
- Harden persisted-state loading with schema validation and explicit skipping of malformed goal/result entries.
- Make hook handling more defensive around message payload shapes and `system` block normalization.
- Expand docs around compatibility, release checks, smoke testing, and security reporting fallback.

## 0.1.10 — 2026-05-30

- Fix `experimental.chat.system.transform` to merge the goal continuation block into the primary system entry instead of pushing a separate one. Prevents `"System message must be at the beginning."` errors on strict-template backends (Qwen on vLLM, several Llama.cpp/Mistral templates). See issue #1.

## 0.1.9 — 2026-05-18

> This release makes the goal plugin much more reliable for real unattended use. Goals now persist across restarts, recover in a safe paused state, expose better status/history visibility, and use smarter no-progress detection to avoid premature stalls. It also hardens persistence with atomic writes, stricter file permissions, and regression tests around corrupt or missing state.

- Persist active goals and recent results to `~/.opencode-goal-plugin/state.json` by default, with recovered goals loaded in a paused state.
- Add `/goal history` plus richer `/goal status` output with recent checkpoint and suggested-next-action hints.
- Replace one-shot low-output pausing with a configurable consecutive-stall grace window via `noProgressTurnsBeforePause` / `--no-progress-turns`.
- Expand tests to cover history output, persistence recovery, repeated-stall pausing, and changing short assistant updates.

## 0.1.8 — 2026-05-18

- Harden `--max-minutes` fallback arithmetic when mixed with millisecond duration overrides.
- Clarify plugin-default config merging and goal-text trust guidance.

## 0.1.7 — 2026-05-18

- Accept bare final-line `goal:complete` and `goal:blocked` markers in addition to canonical bracketed markers, matching observed model output during smoke testing.

## 0.1.6 — 2026-05-18

- Add `/goal pause` plus clear aliases (`stop`, `off`, `reset`, `none`, `cancel`).
- Preserve the last achieved goal in `/goal status` after `[goal:complete]`.
- Make `/goal resume` restart the same objective with a fresh local budget after pause, blocker, no-progress pause, prompt failures, or limit stops.
- Pause goals after repeated auto-continue prompt failures instead of retrying indefinitely.
- Use OpenCode structured app logging when available, with console logging as a fallback.

## 0.1.5 — 2026-05-18

- Change default `maxDurationMs` from 5 minutes to 15 minutes so the turn limit is the binding safety brake at typical LLM latency (30–90 s/turn).
- Rewrite README: clearer structure, limits table with effective-turn-count and token-budget notes, per-goal flags table, updated default values in config examples.

## 0.1.4 — 2026-05-18

- Fix `parseGoalArguments` to reject flags-as-values and dangling flags (e.g. `/goal fix tests --max-turns --max-tokens 50000` no longer corrupts the condition or silently swallows flags).
- Fix `/goal resume` to no-op when the goal is already running instead of resetting `lastContinueAt`.
- Fix `experimental.chat.system.transform` to strip the trailing newline from the system block when no limit warnings apply, matching `buildContinueMessage` behavior.
- Remove live `seenTokens`/`seenOutputTokens` Map references from `testInternals`.
- Update OpenCode command examples to use `$ARGUMENTS`.
- Clarify OpenCode compatibility, in-memory goal lifetime, token-budget limits, and manual smoke testing.
- Add CI, contribution, and security policy files.
- Track assistant output progress separately from broad token-budget accounting.
- Expand test coverage: `--max-duration-ms` flag, dangling/adjacent flags, `promptAsync` error path, thrown-error recovery, `[goal:complete]` state cleanup, already-sent wrapup silent stop, multi-session isolation, `formatStatus` shape, and command no-active-goal paths.

## 0.1.3

- Add structured continuation prompts with goal framing, budget context, and completion-audit instructions.
- Wrap goal text as user-provided task data in `<goal_objective>` tags.
- Use UUID goal IDs for stale-update protection.
- Pause auto-continue after near-zero-output turns.
- Add budget wrap-up prompts near the tracked token limit.
- Store blocked reasons for `/goal status`.
- Track `lastProgressAt` and no-progress turn count in status.
- Add `/goal resume` for stopped in-memory goals.

## 0.1.2

- Fix package entrypoints for OpenCode package resolution.
- Export the plugin using OpenCode's v1 plugin module shape.
- Add `session.status` idle handling alongside deprecated `session.idle`.
- Tighten completion marker matching to final-line markers only.
- Add stale-goal checks around awaited idle-handler work.
- Make system prompt injection idempotent.
- Add tests for marker matching, option parsing, idle handling, and clear-during-idle behavior.

## 0.1.1

- Add configurable safety limits and per-goal overrides.
- Add cooldown and near-limit warnings.
- Clean up tracked message token entries when goals are cleared.

## 0.1.0

- Initial experimental marker-based `/goal` plugin.