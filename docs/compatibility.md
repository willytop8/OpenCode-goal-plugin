# Compatibility policy

## Supported package surface

The latest published release is the supported line. Public compatibility covers:

- the package root and `opencode-goal-plugin/server` ESM exports
- the declarations exported by `index.d.ts`
- the documented `GoalPluginOptions` fields
- the documented OpenCode hook names
- the six canonical goal tools and five legacy tool aliases
- persisted-state recovery from versions documented in the changelog
- concurrent persistence for distinct OpenCode sessions in one project, with
  single-writer protection retained per session and passive goal behavior for
  a same-session process that does not own the lease

The package requires Node.js 18 or newer and OpenCode 1.17.15 or newer,
including the OpenCode 2 line (see [OpenCode 2](#opencode-2) below for what is
verified there). CI runs the complete unit suite on Node 18, 20, 22, and
24. Installed-package contracts compile TypeScript consumers using both NodeNext
and Bundler resolution and require a clean npm-tarball install to expose the
default agent-tool surface without a separately installed OpenCode helper package.

Filesystem-sensitive lifecycle tests run on Linux, macOS, and Windows. POSIX file
mode and symbolic-link protections are applied where the operating system supports
them; the plugin does not claim that Windows provides equivalent POSIX semantics.
The Windows job also runs the installed-package type, host, and tool contracts
so their portable npm launcher path is exercised in CI.

When two processes open the same OpenCode session, only the lease owner may read
or change that session's goal workflow. The contender keeps ordinary chat and
unrelated tools available, but goal controls are denied and ambient hooks do not
attempt a takeover. Canonical goal tools return the stable envelope code
`session_owned_elsewhere`; a `/goal` slash command instead produces a
human-readable denial through its normal model-rendered command turn. Once the
owner exits, an explicit goal command or tool may acquire the shard; recovered
active goals load paused and require an explicit resume. Forking creates a
distinct session shard and remains the supported way to work concurrently from
the same conversation.

The immutable-claim lease protocol atomically hard-links a complete regular-file
compatibility guard at `<shard>/state.json.lock`; active owners publish unique
claims in the sibling `<shard>/state.json.lock.claims-v2/` directory. Publication
is no-replace: an older lock directory and the current guard cannot both win the
same startup race. Older releases treat the future-dated guard as non-reclaimable,
while current releases determine ownership only from immutable claims. Automatic
takeover requires all participating processes to run the current release.
Legacy, incomplete, tampered, or unsupported lease layouts fail closed rather
than being rewritten online. If that condition persists, first close every
OpenCode process that could own the session and upgrade them; then either fork
the session or manually remove only the affected shard's adjacent `.lock` file
or legacy directory and `.lock.claims-v2` directory. Do not remove its state or
lifecycle ledger. The local filesystem must support regular-file hard links
and preserve the guard's future timestamp; the plugin does not fall back to a
weaker publication protocol.

## OpenCode host compatibility

OpenCode's plugin and SDK request shapes differ between the 1.x and 2.x lines,
and may still change within a line. Automated tests cover both current flattened
session inputs and the legacy generated-client shape, and the OpenCode 2
adapter has its own suite; a real-host smoke test remains required when hook or
SDK behavior changes. The current manual provider matrix is maintained in
[providers.md](providers.md).

OpenCode custom commands still become model turns. The plugin handles `/goal`
arguments in `command.execute.before` on OpenCode 1 — where it mutates the
host-retained parts array in place so the turn contains the plugin-generated
command result rather than raw command text — and registers the command itself
on OpenCode 2, submitting that same generated result as the prompt. Both make
command routing deterministic, but neither turns the hook into a direct-render
API: the selected model remains responsible for the visible response.

For objective-bearing commands, retained file attachments may be expanded by
OpenCode into synthetic Read/MCP text and file parts before `chat.message`. The
plugin correlates that host-resolved shape to the exact one-shot command and
generated message/session before treating it as plugin-owned. Each retained
file must yield at least one resolved companion part; a host-reported read error
pauses the goal without reclassifying the command as human intervention.

OpenCode 1.17.15 and 1.18.10 do not invoke
`experimental.chat.system.transform`. Control-command correctness therefore
comes from the rewritten turn's escaped reporting frame, fail-closed tool
blocking, and parent-correlated lifecycle suppression. The system transform
remains registered as additional protection for hosts that support it.

## OpenCode 2

**Status: supported.** Verified against a real OpenCode **2.0.16** host on
Windows (contributor testing), with independent macOS acceptance for Plan activation, restricted completion auditing and safe reload recovery. The V2 hook surface is pinned by `test/v2-bridge.test.js`.

`engines.opencode` is `>=1.17.15` with no upper bound: one entrypoint serves
both lines. OpenCode 1 reads `id` + `server` from the default export;
OpenCode 2 reads `id` + `setup` and ignores `server`. `src/v2-bridge.js`
adapts OpenCode 2's hook domains onto the V1 hook contract the goal core
already implements, so the workflow itself (state machine, persistence
lease, budgets, tool surface, ledger) is shared code rather than a fork.

### Verified on a live 2.0.16 host

| Surface | Result |
| --- | --- |
| Package exports | Installed-tarball contracts validate the dual V1/V2 entrypoint; the exact 0.11.0 tarball passed independent macOS host acceptance |
| Plugin load through a local `.opencode/plugins/<file>.js` entry | `state: active` |
| Slash command registered through `ctx.command.transform` | `goal` listed by `GET /api/command` with the plugin's description |
| Native agents registered through `ctx.agent.transform` | `goal` (primary) and `goal-verify` (subagent, hidden) present in `GET /api/agent` with their system prompts and translated permission rules |
| Config reload | re-arms the deferred command-ownership check via `command.updated` |
| Command ownership over a legacy config `command.goal` entry, cold location boot | the plugin's framed control result is the admitted turn and carries the `opencode-goal-plugin` correlation metadata; the config template's `$ARGUMENTS` text never reaches the model |
| Full goal run to completion on a live provider | `/goal <objective>` → agent tool work → `goal_complete` → archived as `state: "achieved"` with the evidence claim, history, and usage recorded |
| Auto-continue loop on a live provider | two `<goal_continuation>` prompts admitted with `<continuation>` metadata and a live `<progress_budget>` countdown, then the talk-only stall gate paused the goal (`stopReason: "no tool calls"`) |
| Session-title indicator (`sessionTitleStatus: true`) | live status line rendered in the session title (`⏸ <objective> · 2/3 · 7s · 11k/200k`) |

Verified by tests against the real goal core (not a mock): `setup(ctx)`
registers every surface the workflow needs, V2 events normalize to the V1
event contract, transcript/message normalization, the flat session-client
inputs, and an end-to-end `/goal set` command turn that creates a goal
instead of being read as user input. The current suite also rejects failed agent switches, altered verifier permissions and stale registration readiness.

Independent macOS acceptance against 2.0.16 uses a local deterministic provider: fresh Plan add/sequence commands are held; `goal_complete` runs through Code Mode, the child receives the `goal-verify` identity and only read/glob/grep tools, and the parent archives only after its verdict. A foreign verifier rejects completion before any child model request. Location reload releases the previous instance's claim and recovers active work paused. These tests use no paid provider.

The plugin context on 2.0.16 does not expose session removal, so its audit children remain retained by the host. If a host exposes `session.remove`, the adapter maps it to the core's cleanup contract. Claims about child deletion are limited to that conditional adapter test.

On 2.0.26 the same acceptance script passes in both modes. That host exposes `session.remove`, so the verifier child is deleted after its verdict. It also appends its own `browser` deny rule to every agent; the verifier ownership check accepts host-added deny rules (which can only narrow access) but still rejects any changed, missing, reordered or widening rule.

### Hook mapping

The isolated live acceptance command requires a pinned host runtime installed outside your real OpenCode config:

```sh
npm install --prefix /tmp/goal-v2-runtime --ignore-scripts --no-audit --no-fund @opencode/cli@2.0.16 @opencode/plugin@2.0.16
OPENCODE_V2_RUNTIME_DIR=/tmp/goal-v2-runtime npm run smoke:v2-host
OPENCODE_V2_RUNTIME_DIR=/tmp/goal-v2-runtime GOAL_V2_FOREIGN_VERIFIER=1 npm run smoke:v2-host
```

The script uses an isolated HOME/config/cache and a localhost deterministic provider. It tests Plan add/sequence, Code Mode completion with the restricted verifier, and paused recovery after reload; the second mode tests rejection of a foreign verifier. `OPENCODE_V2_BINARY` can select a different binary explicitly. The positive child-retention result reflects the 2.0.16 plugin API limit described below. This optional live acceptance command is separate from the network-free behavior benchmark and does not run automatically in the release gate.

| OpenCode 1 | OpenCode 2 |
| --- | --- |
| `chat.message` | `ctx.session.hook("prompt")` (correlation marker carried in prompt metadata) |
| `chat.params` | `ctx.session.hook("context")` |
| `experimental.chat.system.transform` | second `ctx.session.hook("context")` editing `event.system` |
| `experimental.session.compacting` | `ctx.session.hook("compaction")` appending to `event.system` |
| `experimental.compaction.autocontinue` | none — V2 has no generic post-compaction auto-continue to suppress |
| `command.execute.before` | `ctx.command.transform`; the executor runs the V1 hook and submits the routed result as the prompt itself |
| `tool.execute.before` | `ctx.tool.hook("execute.before")` (a throw still blocks the tool) |
| `event` | `ctx.event.subscribe()` with envelope normalization |
| `tool` map | `ctx.tool.transform` (Zod v4 is Standard Schema, accepted directly) |
| `config` agents | `ctx.agent.transform` (`update` upserts) |
| `dispose` | cleanup function returned by `setup` |
| `client.session.*` (legacy/flat SDK) | `ctx.session.{context,prompt,get,update,interrupt,create}` behind the same flat contract |

Event normalization, because V2 renamed or removed the V1 event types:
`session.execution.succeeded` → `session.idle` (the auto-continue driver),
`session.execution.started` → `session.status: busy`,
`session.execution.failed` → `session.error`, `session.execution.interrupted`
→ `session.error` (`MessageAbortedError`), `session.compaction.ended` →
`session.compacted`, `session.step.ended` → `message.updated` (usage and
progress), `session.agent.selected`/`session.model.selected` →
`session.updated`, with `permission.replied`, `session.status`, and
`session.idle` passed through.

### Divergences from OpenCode 1

1. **Command ownership.** The plugin registers `/goal` itself. OpenCode 2
   registers config `command`/`commands` entries *after* user plugins, so a
   legacy `command.goal` entry would otherwise shadow the plugin handler; the
   bridge re-asserts its registration after activation and logs a warning if a
   foreign definition still owns the name. Dropping the entry is recommended
   on V2 — nothing needs to replace it.
2. **Step failures are not terminal.** V2 retries retryable `session.step.failed`
   errors; the bridge does not pause a goal on them. Terminal provider errors
   arrive as `session.execution.failed` and pause as before.
3. **Message parents.** V2 messages carry no `parentID`. It is derived from
   transcript order for history reads and from the last admitted prompt for
   live events, which is what control-command suppression correlates on.
4. **No `client.app.log`.** V2's plugin context has no structured log API, so
   advisory warnings and errors use the same console fallback V1 already uses
   when `app.log` is unavailable; debug-level diagnostics stay silent.
5. **Completion-audit children.** `session.create` has no `parentID` field on
   V2, so the bridge records `parentSessionID` in the child's session metadata
   and echoes it back to satisfy the auditor's integrity check. V2 exposes no
   session-delete operation to the plugin context, so audit children are not
   removed afterwards (V1 deleted them when `client.session.delete` existed).
   Every built-in audit verifies the live agent system and complete permission rules before switching agents. Failed switches abort submission. The synchronous auditor waits for V2 execution before reading the assistant verdict.
6. **Agent permission vocabulary.** V1 agent tool maps are translated to
   ordered V2 rules, emitting both spellings for renamed actions
   (`bash`→`shell`, `write`/`patch`→`edit`, `task`→`subagent`), with the `*`
   catch-all first because V2 uses last-match-wins. V2 `Agent.Info` has no
   `tools` map, so disabled tools become `deny` rules.
7. **Active-children gate.** `noContinueWhileChildrenActive` reads children
   and statuses from the event stream (or `session.list`/`session.active` when
   the host exposes them). Unknown state fails open, as documented for hosts
   that cannot report children.
8. **Local checkouts.** A configured plugin *directory* containing a
   `package.json` is resolved by name and version and installed into OpenCode's
   npm cache from the registry, so a local checkout is only loaded through a
   `.opencode/plugins/<file>.js` entry (or after publishing).

Same-process reloads explicitly retire the old instance before the replacement acquires persistence. Quiet live owners remain authoritative; another process must exit or release its claim before takeover.

### Configuration

This plugin is **server-only**: `package.json` exports the root and
`opencode-goal-plugin/server`, and there is no TUI plugin entrypoint. Its
configuration therefore lives entirely in `opencode.json` on any OpenCode
line — `plugin`/`plugins` plus, on OpenCode 1 only, the matching `command`
entry:

```jsonc
// OpenCode 1
{ "plugin": ["opencode-goal-plugin@0.11.0"],
  "command": { "goal": { "template": "$ARGUMENTS", "agent": "build" } } }

// OpenCode 2 (the command entry is not needed and should be omitted)
{ "plugins": ["opencode-goal-plugin@0.11.0"] }

// OpenCode 2 with plugin options: repeat the exact package spec in object
// form so the project entry — and its options — takes precedence over a
// same-package entry in the user-level config (verified on 2.0.16; a
// different spec, such as a local path, does not replace it).
{ "plugins": [
  { "package": "opencode-goal-plugin@0.11.0", "options": { "sessionTitleStatus": true } }
] }
```

Plugins that *do* ship a TUI component are registered in a second file whose
location differs between OpenCode lines, and those formats must not be mixed.
That distinction does not apply here — including for the
[status indicator](../README.md#status-indicator), which reaches the TUI through
the session title rather than through a TUI plugin.

## Versioning

Semantic-versioning intent is:

- patch: compatible fixes, documentation, and stronger verification
- minor: backward-compatible options, hooks, commands, or tools
- major: removal or incompatible change to a documented public surface

`testInternals` is exported for diagnostics and the project's own tests; it is not
part of the semantic-version compatibility guarantee.
