/**
 * Type declarations for opencode-goal-plugin.
 *
 * These describe the plugin-level configuration object accepted in
 * `opencode.json` under `plugin: [["opencode-goal-plugin", { ... }]]`,
 * and the shape of the module's exports.
 */

/**
 * Verdict returned by a completion auditor (built-in or custom). See
 * {@link GoalPluginOptions.auditor} and {@link GoalPluginOptions.completionAudit}.
 */
export interface CompletionAuditVerdict {
  /** `true` to archive the goal as achieved; `false` to reject the completion. */
  approved: boolean
  /** Human-readable reason, surfaced in the goal's status when rejected. */
  reason?: string
}

/** A timestamped lifecycle entry retained with an active or archived goal. */
export interface GoalHistoryEntry {
  type: string
  detail: string
  timestamp: number
}

/** A bounded progress checkpoint retained with a goal. */
export interface GoalCheckpoint {
  summary: string
  timestamp: number
}

/** Normalized token and cost usage accumulated for the current goal run. */
export interface GoalUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  costKnown: boolean
}

/** Read-only goal snapshot passed to custom completion auditors. */
export interface GoalAuditSnapshot {
  goalId: string
  runId: string
  condition: string
  successCriteria: string
  constraints: string
  mode: "normal" | "ordered"
  sessionID: string
  turnCount: number
  startedAt: number
  pausedAt: number
  totalTokens: number
  usage: Readonly<GoalUsage>
  options: Readonly<GoalPluginOptions>
  lastStatus: string
  blockedReason: string
  stopped: boolean
  stopReason: string
  history: readonly Readonly<GoalHistoryEntry>[]
  checkpoints: readonly Readonly<GoalCheckpoint>[]
  lastCheckpoint: Readonly<GoalCheckpoint> | null
}

/** Arguments passed to a custom {@link GoalPluginOptions.auditor} function. */
export interface CompletionAuditContext {
  /** The goal being audited (objective, budget usage, checkpoints, etc.). */
  goal: Readonly<GoalAuditSnapshot>
  /** The OpenCode session ID the goal belongs to. */
  sessionID: string
  /** The assistant's latest response text, containing the `[goal:evidence]`/`[goal:complete]` claim. */
  latestText: string
}

/** Options for the built-in child-session completion auditor (`completionAudit: true`). */
export interface CompletionAuditorOptions {
  /**
   * How long, in milliseconds, the built-in auditor waits for a verdict from
   * its child OpenCode session. A timeout rejects the audit and pauses the
   * goal. Operational failures follow {@link failurePolicy}.
   * @default 120000
   */
  timeoutMs?: number

  /**
   * Result used when the child-session API is unavailable, malformed, throws,
   * or times out. Semantic rejection or an invalid verdict always rejects.
   * `"approve"` is an explicit compatibility escape hatch.
   * @default "reject"
   */
  failurePolicy?: "reject" | "approve"
}

/**
 * Configuration options for opencode-goal-plugin. All fields are optional;
 * unset fields fall back to the plugin's built-in defaults. These act as
 * the default limits for every goal set in a session, and most of the
 * budget/behavior fields can be overridden per-goal via `/goal` command
 * flags (e.g. `--max-turns`, `--success`, `--mode`).
 */
export interface GoalPluginOptions {
  /**
   * OpenCode session SDK argument shape. PluginInput currently supplies the
   * legacy generated client; set `"flat"` when embedding with the v2 SDK.
   * The compatibility adapter remembers the successful shape per operation.
   * @default "legacy"
   */
  sdkShape?: "legacy" | "flat"

  /**
   * Maximum number of auto-continue turns sent toward a goal before it is
   * stopped for exceeding limits. Overridable per-goal with `--max-turns`.
   * @default 10
   */
  maxTurns?: number

  /**
   * Maximum wall-clock duration, in milliseconds, a goal may run before it
   * is stopped for exceeding limits. Overridable per-goal with
   * `--max-duration-ms` or `--max-minutes`.
   * @default 900000
   */
  maxDurationMs?: number

  /**
   * Maximum context token budget a goal may consume before it is stopped
   * for exceeding limits. Overridable per-goal with `--max-tokens` or the
   * `--budget` shorthand (accepts a `k`/`m` suffix, e.g. `100k`, `1.5m`).
   * @default 200000
   */
  maxTokens?: number

  /**
   * Minimum delay, in milliseconds, enforced between consecutive
   * auto-continue prompts. Overridable per-goal with `--cooldown-ms`.
   * @default 1500
   */
  minDelayMs?: number

  /**
   * How many recent session messages to scan when looking for the latest
   * assistant turn before auto-continuing. Higher values make long,
   * tool-heavy sessions less likely to lose the most recent assistant
   * response.
   * @default 50
   */
  maxRecentMessages?: number

  /**
   * Output token floor below which a turn is considered "low-output" for
   * no-progress detection. Overridable per-goal with
   * `--no-progress-threshold`.
   * @default 50
   */
  noProgressTokenThreshold?: number

  /**
   * Grace window for low-output stalls: the goal is paused only after this
   * many consecutive stalled low-output turns, rather than on the first
   * one. Overridable per-goal with `--no-progress-turns`.
   * @default 2
   */
  noProgressTurnsBeforePause?: number

  /**
   * Grace window for tool-free continuation turns (a "talk only" turn that
   * calls no tool). Complements the no-progress check by catching
   * self-chat loops that still produce output. Overridable per-goal with
   * `--no-tool-turns`. Set the plugin option to `0` to disable this heuristic.
   * @default 2
   */
  noToolCallTurnsBeforePause?: number

  /**
   * Fraction (between 0 and 1, exclusive) of any budget (turns, duration,
   * or tokens) at which the plugin sends a one-time "wrap up" prompt
   * nudging the model to finish before the hard limit is hit.
   * @default 0.8
   */
  budgetWrapupRatio?: number

  /**
   * Number of remaining auto-continue turns at which a limit-approaching
   * warning is included in status output.
   * @default 3
   */
  warnTurnsRemaining?: number

  /**
   * Remaining duration, in milliseconds, at which a limit-approaching
   * warning is included in status output.
   * @default 60000
   */
  warnDurationMsRemaining?: number

  /**
   * Remaining context tokens at which a limit-approaching warning is
   * included in status output.
   * @default 25000
   */
  warnTokensRemaining?: number

  /**
   * Maximum number of consecutive prompt failures (e.g. transport errors
   * sending the auto-continue prompt, or repeated missing-evidence /
   * missing-blocker format violations) tolerated before the goal is
   * stopped.
   * @default 3
   */
  maxPromptFailures?: number

  /**
   * Whether to persist active/backgrounded goals and recent goal results
   * to disk so they survive a restart. Recovered active goals are loaded
   * in a paused state. Set to `false` for purely in-memory behavior (this
   * also disables the lifecycle ledger).
   * @default true
   */
  persistState?: boolean

  /**
   * Filesystem path where persisted goal state is written when
   * `persistState` is enabled. Overrides both the project-local default
   * and the `OPENCODE_GOAL_STATE_PATH` environment variable.
   * @default "<cwd>/.opencode/goals/state.json"
   */
  stateFilePath?: string

  /**
   * Filesystem path for the append-only lifecycle ledger
   * (`<event> per line`, used to reconstruct active goals if the main
   * state file is missing or corrupted).
   * @default "<stateFilePath>.ledger.jsonl"
   */
  ledgerFilePath?: string

  /** Maximum bytes in one lifecycle-ledger generation. @default 2097152 */
  ledgerMaxBytes?: number

  /** Number of rotated lifecycle-ledger generations to retain (0-10). @default 3 */
  ledgerRetentionFiles?: number

  /**
   * How long, in milliseconds, a completed goal's summary remains
   * available through `/goal status` after the goal leaves active memory.
   * @default 604800000
   */
  resultRetentionMs?: number

  /**
   * Maximum number of completed-goal summaries retained in process memory
   * before the oldest ones are evicted.
   * @default 200
   */
  maxStoredResults?: number

  /**
   * The slash command the plugin owns. Set to e.g. `"objective"` to drive
   * the workflow with `/objective` instead of `/goal`; a leading slash is
   * tolerated and stripped. Remember to register the matching command
   * name in your OpenCode `command` config.
   * @default "goal"
   */
  commandName?: string

  /**
   * Whether the plugin installs its `command.execute.before` hook at all.
   * Set to `false` if you only want the auto-continue/persistence
   * behavior driven programmatically (e.g. via {@link registerTools})
   * and don't want the plugin to own a slash command.
   * @default true
   */
  registerCommand?: boolean

  /**
   * Whether the plugin registers the agent-facing goal tools
   * (canonical `goal_status`, `goal_set`, `goal_pause`, `goal_resume`,
   * `goal_block`, `goal_complete`, plus legacy `get_goal`,
   * `get_goal_history`, `set_goal`, `update_goal`, `clear_goal`).
   * Canonical tools return versioned JSON envelopes. Requires the optional `@opencode-ai/plugin` peer
   * dependency; when it is absent, tool registration is silently skipped
   * and the command/event hooks still work.
   * @default true
   */
  registerTools?: boolean

  /** Register collision-safe native `goal` and `goal-verify` agents through OpenCode's config hook. */
  registerAgents?: boolean

  /** Name of the native primary goal agent. @default "goal" */
  goalAgentName?: string

  /** Name of the native read-only verifier subagent. @default "goal-verify" */
  verifierAgentName?: string

  /**
   * Enables the built-in child-session completion auditor: before a
   * `[goal:complete]` is archived, the plugin spawns an independent
   * OpenCode session to verify the completion against the goal and
   * workspace. Ignored if {@link auditor} is also set (the custom
   * auditor takes precedence). Tune the built-in auditor with
   * {@link auditorOptions}.
   * @default false
   */
  completionAudit?: boolean

  /**
   * Supply a custom completion auditor instead of the built-in
   * child-session one. Takes precedence over `completionAudit: true`.
   * A verdict of `{ approved: false }` pauses the goal (stop reason
   * `"audit rejected"`) instead of archiving it. A thrown error is
   * treated as a rejection (fail closed).
   */
  auditor?: (context: CompletionAuditContext) => Promise<CompletionAuditVerdict>

  /**
   * Tuning options for the built-in child-session auditor. Ignored when
   * a custom {@link auditor} is supplied.
   */
  auditorOptions?: CompletionAuditorOptions

  /**
   * Whether the plugin announces completion/blocked audits (an
   * audit-start and an audit-result message) instead of running silently.
   * @default true
   */
  auditMessages?: boolean

  /**
   * Custom sink for audit announcements. Defaults to routing through
   * OpenCode's structured log (`client.app.log`) and TUI toast when those
   * host APIs are available. Provide this to route audit messages elsewhere.
   */
  auditMessenger?: (sessionID: string, text: string) => Promise<void> | void
}

/**
 * OpenCode plugin hook map returned by the plugin's `server` factory.
 * Matches OpenCode's plugin hook contract; kept loose (`unknown`
 * input/output) since hook payload shapes are defined by OpenCode itself,
 * not by this package.
 */
export interface GoalPluginHooks {
  /** Registers collision-safe native goal and verifier agents. */
  config: (config: unknown) => Promise<void>
  /** Omitted entirely when {@link GoalPluginOptions.registerCommand} is `false`. */
  "command.execute.before"?: (input: unknown, output: unknown) => Promise<void>
  /** Enforces read-only tool behavior when inspection, pause, or clear command text is routed to the model. */
  "tool.execute.before": (input: unknown, output: unknown) => Promise<void>
  event: (input: unknown) => Promise<void>
  "experimental.chat.system.transform": (input: unknown, output: unknown) => Promise<void>
  "experimental.compaction.autocontinue": (input: unknown, output: unknown) => Promise<void>
  "experimental.session.compacting": (input: unknown, output: unknown) => Promise<void>
  /**
   * Agent-facing tool definitions, present only when
   * {@link GoalPluginOptions.registerTools} is enabled (default) and the
   * optional `@opencode-ai/plugin` peer dependency is installed.
   */
  tool?: Record<string, unknown>
  /** Cancels pending continuation work and releases this plugin instance. */
  dispose: () => Promise<void>
}

/**
 * The plugin's `server` factory. OpenCode calls this with a client bound
 * to the running session and the resolved plugin options from
 * `opencode.json`.
 */
export function GoalPlugin(
  context: {
    client: unknown
    /** OpenCode's resolved project directory for this plugin instance. */
    directory?: string
    /** OpenCode's resolved worktree directory for this plugin instance. */
    worktree?: string
  },
  options?: GoalPluginOptions,
): Promise<GoalPluginHooks>

/** Internal diagnostic/test helpers. Not covered by semantic-version compatibility guarantees. */
export const testInternals: Readonly<Record<string, unknown>>

/**
 * Default export consumed by OpenCode's plugin loader:
 * `{ "opencode-goal-plugin": { ... } }` in `opencode.json` resolves `id`
 * and calls `server` to obtain the plugin's hooks.
 */
declare const goalPlugin: {
  id: "opencode-goal-plugin"
  server: typeof GoalPlugin
}

export default goalPlugin
