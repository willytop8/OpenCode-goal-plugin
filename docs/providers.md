# Provider / model compatibility

opencode-goal-plugin works with any model OpenCode can talk to, but two things
vary by provider and model:

1. **Marker compliance** — whether the model reliably ends its response with
   `[goal:complete]` / `[goal:blocked]` (or the bracket-less form) on its own
   final line, as instructed. Models that trail extra text after the marker
   or paraphrase it ("the goal is complete") will not be detected as
   complete; the plugin's safety limits (`--max-turns`, `--max-minutes`,
   `--max-tokens`) are the backstop in that case.
2. **Hook output display** — whether the plugin's own response text (e.g.
   `No active goal. Set one with...`) is rendered in the OpenCode TUI, or
   whether the raw command argument is instead routed to the model as a
   normal chat turn. This is an OpenCode-host behavior, not model-specific,
   but is included here since it's most visible while testing a new model.
   See the [OpenCode version compatibility table](../README.md#opencode-version-compatibility)
   in the README for the current findings.

All rows below were verified manually against the real OpenCode TUI (`tmux`
+ live provider credentials, no mocks) on OpenCode 1.17.15, driving the
plugin through `/goal status`, `/goal <condition> --max-turns N`, and
inspecting the plugin's persisted `state.json` to confirm state mutations
(limit parsing, turn/stop accounting, completion detection) independent of
what was rendered in the terminal.

## Tested models

| Provider | Model | Marker compliance | Notes |
|---|---|---|---|
| `opencode-go` | `qwen3.7-plus` | ✅ Clean | Emits bare `goal:complete` on its own final line consistently. Completed a 1-turn goal without needing auto-continue. |
| `opencode-go` | `glm-5.2` | ⚠️ Inconsistent | Emits the marker but sometimes appends explanatory text after it on the same or a later line, which breaks the "own final line" detection. The plugin's `--max-turns` limit correctly stopped the goal as a backstop when this happened. |
| `deepseek` | `deepseek-chat` | ✅ Clean | Emits bare `goal:complete` on its own final line consistently. Completed a 1-turn goal without needing auto-continue. Correctly parses per-goal flags (`--max-turns`, etc.) out of the condition text. |

Untested at time of writing: `deepseek-reasoner`, `mistral/*`, `openrouter/*`,
and any `nvidia`/`google` provider — add rows here as they're verified. See
[Testing a new model](#testing-a-new-model) below.

## Strict-template backends

Some backends (notably certain Qwen deployments on vLLM, and several
Llama.cpp/Mistral chat templates) reject a `system` role message that isn't
the very first message in the conversation, with an error like `"System
message must be at the beginning."` opencode-goal-plugin's
`experimental.chat.system.transform` hook merges the goal continuation block
into the primary system entry instead of appending a separate one, which
avoids this. This is covered by regression tests in
[`test/goal-plugin.test.js`](../test/goal-plugin.test.js) and does not
require any provider-specific configuration.

## Testing a new model

No LLM call is required to verify the plugin loads correctly — run
`npm run verify` first. To check marker compliance and hook behavior for a
specific provider/model:

1. Point an OpenCode config at the plugin (see
   [Local development](../README.md#local-development) in the README) and
   register the `goal` command.
2. Launch OpenCode against the model you want to test:
   ```sh
   opencode -m <provider>/<model>
   ```
3. Run a short, deterministic goal that should complete in one turn:
   ```
   /goal say hi and end with [goal:complete] --max-turns 2
   ```
4. Confirm the model's final line is exactly `[goal:complete]` or
   `goal:complete` — nothing after it. If it trails extra text, that's an
   "inconsistent" marker-compliance result; note whether `--max-turns`
   correctly stops the goal as a backstop.
5. Run `/goal status` and check whether the plugin's text (e.g. `No active
   goal...` or `Active goal: ...`) is rendered directly, or whether the
   command text was instead routed to the model as a chat turn.
6. Cross-check state mutations directly against the persisted state file
   (`~/.opencode-goal-plugin/state.json` by default) to confirm the goal's
   `options` reflect the flags you passed and `stopReason`/`state` reflect
   what actually happened — this is authoritative even when the TUI display
   doesn't show the plugin's own output.
7. Add a row to the table above with your findings, including the OpenCode
   version you tested against.
