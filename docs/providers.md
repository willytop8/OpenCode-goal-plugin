# Provider / model compatibility

opencode-goal-plugin works with any model OpenCode can talk to, but two things
vary by provider and model:

1. **Marker compliance** — whether the model reliably ends its response with
   `[goal:complete]` (or the bracket-less form) on its own final line, with a
   preceding `[goal:evidence]` line summarizing what it actually verified.
   Since the completion-evidence requirement was added, a bare
   `[goal:complete]` with no evidence line is **rejected** and the plugin
   re-prompts with an explicit `<evidence_required>` block — this is a
   real safety net, not just documentation: a model that initially skips the
   evidence line gets one automatic correction cycle before hitting its
   turn/time/token budget.
2. **Custom-command presentation** — OpenCode sends custom commands through a
   normal model turn rather than directly rendering plugin-hook output. The
   plugin now mutates OpenCode's retained command-parts array in place, so that
   turn contains the deterministic plugin-generated result instead of raw
   `$ARGUMENTS`. Control results include an escaped reporting frame, backed by
   tool blocking and lifecycle suppression; the model may still summarize or
   paraphrase the supplied data.
   This is primarily host behavior, but it remains worth checking with each
   provider/backend. See the [OpenCode version compatibility table](../README.md#opencode-version-compatibility)
   for the historical v0.6.6 findings.

All rows below were verified against real OpenCode processes with live
provider credentials and no mocked plugin hooks on OpenCode 1.17.15 before the
in-place command-parts change. They drove the plugin through `/goal status`,
`/goal <condition> --max-turns N`, and inspected the persisted state file to
confirm state mutations (limit parsing, turn/stop accounting, evidence-gated
completion detection) independent of what was rendered in the terminal.

## Tested models

| Provider | Model | Marker compliance | Notes |
|---|---|---|---|
| `opencode` | `deepseek-v4-flash-free` | ✅ Canonical tools | OpenCode 1.17.15, isolated HOME/XDG/project, loading the exact 0.6.2 branch source by file URL. In a real interactive PTY, the model fixed an intentionally failing two-test project, ran the tests to 2/2 passing, and completed through `goal_complete`. A second goal checkpointed after writing `step-1`; the plugin ledger then recorded `auto-continue 1/2`, after which the model wrote and verified `step-2` and completed. Sessions: `ses_0b021d93affeCsNvWkmJWwZzF2` and `ses_0b01f3767ffej4Mn6DMSWft0aX`. `/goal status` text was routed to the model by this host version, which then called `goal_status`; the persisted ledger remained authoritative. |
| `opencode-go` | `qwen3.7-plus` | ✅ Self-corrects | First attempt emitted bare `[goal:complete]` with no evidence line and was correctly rejected by the plugin. On the very next turn it read the `<evidence_required>` re-prompt, added a `[goal:evidence]` line, and completed cleanly — a good demonstration of the evidence gate actually improving behavior rather than just failing closed. |
| `opencode-go` | `glm-5.2` | ✅ Clean | Emitted a correct `[goal:evidence] ... [goal:complete]` pair on the first attempt. (An earlier plugin version without the evidence requirement showed GLM-5.2 sometimes trailing extra text after a bare marker — the more structured `<completion_audit>` prompt this plugin version sends appears to help.) |
| `deepseek` | `deepseek-chat` | ✅ Clean | Emitted a correct `[goal:evidence] ... [goal:complete]` pair on the first attempt, both in a short synthetic goal and in the full [demo](../demo/) (autonomously located and fixed a real bug, then reported evidence-backed completion). Correctly parses per-goal flags (`--max-turns`, etc.) out of the condition text. |

## OpenCode 1.17.15 lifecycle canaries

The `opencode/deepseek-v4-flash-free` row was also exercised through an
isolated project, HOME, and XDG directories while loading the exact 0.6.2
source by `file://` URL. Persisted state, ledger entries, and file contents
were checked independently of the model's prose.

| Scenario | Result | Evidence |
|---|---|---|
| Normal completion | ✅ Pass | `ses_0b021d93affeCsNvWkmJWwZzF2`: fixed an intentionally failing project, reran 2/2 tests, and completed with structured evidence. |
| Idle auto-continuation | ✅ Pass | `ses_0b01f3767ffej4Mn6DMSWft0aX`: checkpointed `step-1`, ledger recorded auto-continue 1/2, then verified `step-2` and completed. |
| Pause and explicit resume across processes | ✅ Pass | `ses_0b01470c1ffeug0LX69fageiVm`: remained paused between OpenCode invocations; explicit resume released it and completion was archived. |
| Concrete blocker and restart | ✅ Pass | `ses_0b013a903ffeg3I6tGbArE2b5E`: stopped with the missing approval-file reason and did not auto-continue after a fresh process loaded it. |
| Hard process interruption and recovery | ✅ Pass | `ses_0b00b37a8ffeDrBshGDutFTqUm`: a running process was terminated during a shell wait; restart recovered paused, status blocked a stale `goal_resume`, the file stayed unchanged, and a later explicit resume completed. |
| Real host compaction | ✅ Pass | `ses_0b00958e3ffekLLH5ztkkvHIPL`: the documented session summarize endpoint returned `true`; exported session data contained a real compaction part plus injected goal/checkpoint context, token accounting reset, and the paused goal resumed cleanly. |
| Clear with stale conversation history | ✅ Pass | `ses_0affb9235ffeWl5LuZxXmvhSfM`: after command-side clearing, the routed model turn attempted `clear_goal` and `goal_resume`; the tool hook rejected all attempts, the file remained `before-clear`, and no goal survived in state. |
| Interactive Esc during a running shell tool | ⚠️ Not established | Esc sent through the automated PTY did not interrupt OpenCode's shell tool. Hard-process recovery is verified above and host-abort hooks have deterministic tests, but this specific TUI input path is not claimed as passed. |

Untested at time of writing: `deepseek-reasoner`, `mistral/*`, `openrouter/*`,
and any `nvidia`/`google` provider — add rows here as they're verified. See
[Testing a new model](#testing-a-new-model) below.

## Strict-template backends

Some backends (notably certain Qwen deployments on vLLM, and several
Llama.cpp/Mistral chat templates) reject a `system` role message that isn't
the very first message in the conversation, with an error like `"System
message must be at the beginning."` opencode-goal-plugin's
`experimental.chat.system.transform` hook, on hosts that invoke it, merges the
goal continuation block into the primary system entry instead of appending a
separate one, which avoids this. OpenCode 1.17.15 and 1.18.10 do not invoke that
experimental hook; command control on those releases uses the self-contained
reporting frame described above. The merge behavior is covered by regression tests in
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
3. Run a short, deterministic goal that should complete in one or two turns:
   ```
   /goal say hi and end with [goal:complete] --max-turns 2
   ```
4. Check whether the first attempt includes a proper `[goal:evidence]` line
   before `[goal:complete]`. If not, confirm the plugin rejects it and
   re-prompts with `<evidence_required>` — then check whether the model
   self-corrects within its remaining turn budget, or exhausts it.
5. Run `/goal status` and confirm the model turn reports the plugin-generated
   status rather than interpreting the raw word `status` as a new request.
   The final wording may be summarized or paraphrased because OpenCode custom
   commands still run through the selected model.
6. Cross-check state mutations directly against the persisted state file
   (`.opencode/goals/state.json`, project-local by default) to confirm the
   goal's `options` reflect the flags you passed and `state`/`stopReason`
   reflect what actually happened — this is authoritative even when the TUI
   display doesn't show the plugin's own output.
7. Add a row to the table above with your findings, including the OpenCode
   version you tested against.
