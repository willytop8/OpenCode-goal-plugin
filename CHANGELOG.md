# Changelog

## Unreleased

- Replace the single-line "Compatibility snapshot" in the README with an OpenCode version compatibility table, manually verified via `tmux` + the OpenCode TUI against `state.json` for each provider/model combination.
- Add `docs/providers.md`, a provider/model compatibility guide covering marker-compliance behavior for `opencode-go/qwen3.7-plus`, `opencode-go/glm-5.2`, and `deepseek/deepseek-chat` (manually verified via the OpenCode TUI against real provider credentials on OpenCode 1.17.15), plus a step-by-step guide for testing new models.
- Add Node 24 to the CI matrix, a weekly scheduled CI run (Mondays 08:00 UTC) to catch upstream drift, a `test:coverage` step, and CI/tests badges to the README.
- Add GitHub issue templates for bug reports (OpenCode version, provider/model, Node version, repro steps) and feature requests (problem solved, scope fit).
- Add an Examples section to the README with copy-pasteable `/goal` commands for common workflows (fixing tests, refactors, audits, migrations).
- Add a Comparison section to the README benchmarking `/goal` support, auto-continue, per-goal overrides, no-progress detection, safety limits, history, persistence, budget wrap-up, and license against Claude Code and Codex.
- Add `npm run verify` / `npx opencode-goal-plugin` installation verification command (`scripts/verify.mjs`). Checks Node >= 18, the plugin module shape, that all 3 hooks register, and that `/goal status`/`/goal set` work — entirely via mock clients, with zero model calls.
- Add TypeScript declarations (`index.d.ts`) covering `GoalPluginOptions`, the plugin hook map, and the module's default export. `package.json` now points `types` at it.
- Warn when setting a new goal replaces an active one instead of silently overwriting it. `/goal <text>` now prefixes its response with `⚠️ Replacing active goal: "<old condition>"` when a goal is already active. (QA#015)
- Fix `/goal <command> extra words` from silently creating goals. `status`, `history`, `resume`, `pause`, and all clear aliases are now first-word-validated — extra arguments produce a helpful error with a corrective hint instead of falling through to goal creation. (QA#021)
- Add 31 comprehensive edge-case tests to the QA audit suite covering: all clear aliases, flag rejection (negative, zero, float, non-numeric), XML escaping, long goal text, newlines, goal overwrite behavior, flags-only rejection, command-like goal text, unicode/emoji, `persistState: false` in-memory-only behavior, double-resume no-op, pause-then-clear, duplicate checkpoint deduplication, single-dash flags, and command-disambiguation errors.

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