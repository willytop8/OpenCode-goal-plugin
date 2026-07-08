/**
 * Type declarations for opencode-goal-plugin.
 *
 * These describe the plugin-level configuration object accepted in
 * `opencode.json` under `plugin: [["opencode-goal-plugin", { ... }]]`,
 * and the shape of the module's exports.
 */

/**
 * Configuration options for opencode-goal-plugin. All fields are optional;
 * unset fields fall back to the plugin's built-in defaults. These act as
 * the default limits for every goal set in a session, and most of them can
 * be overridden per-goal via `/goal` command flags (e.g. `--max-turns`).
 */
export interface GoalPluginOptions {
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
   * for exceeding limits. Overridable per-goal with `--max-tokens`.
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
   * sending the auto-continue prompt) tolerated before the goal is stopped.
   * @default 3
   */
  maxPromptFailures?: number

  /**
   * Whether to persist active goals and recent goal results to disk so
   * they survive a restart. Recovered active goals are loaded in a paused
   * state. Set to `false` for purely in-memory behavior.
   * @default true
   */
  persistState?: boolean

  /**
   * Filesystem path where persisted goal state is written when
   * `persistState` is enabled. Useful for per-project or ephemeral
   * storage locations.
   * @default "~/.opencode-goal-plugin/state.json"
   */
  stateFilePath?: string

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
}

/**
 * OpenCode plugin hook map returned by the plugin's `server` factory.
 * Matches OpenCode's plugin hook contract; kept loose (`unknown`
 * input/output) since hook payload shapes are defined by OpenCode itself,
 * not by this package.
 */
export interface GoalPluginHooks {
  "command.execute.before": (input: unknown, output: unknown) => Promise<void>
  event: (input: unknown) => Promise<void>
  "experimental.chat.system.transform": (input: unknown, output: unknown) => Promise<void>
  [hook: string]: unknown
}

/**
 * The plugin's `server` factory. OpenCode calls this with a client bound
 * to the running session and the resolved plugin options from
 * `opencode.json`.
 */
export function GoalPlugin(
  context: { client: unknown },
  options?: GoalPluginOptions,
): Promise<GoalPluginHooks>

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
