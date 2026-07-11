import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repository = new URL("..", import.meta.url)
const repositoryPath = fileURLToPath(repository)
const root = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-types-"))
const packDirectory = join(root, "pack")
const consumerDirectory = join(root, "consumer")
const cacheDirectory = join(root, "npm-cache")
const npmEnvironment = { ...process.env, npm_config_cache: cacheDirectory }
const tsc = join(repositoryPath, "node_modules", "typescript", "bin", "tsc")

const fixture = `
import goalPlugin, {
  GoalPlugin,
  type CompletionAuditContext,
  type GoalPluginHooks,
  type GoalPluginOptions,
} from "opencode-goal-plugin"
import serverPlugin from "opencode-goal-plugin/server"

const options = {
  sdkShape: "flat",
  maxTurns: 12,
  maxDurationMs: 60_000,
  maxTokens: 50_000,
  minDelayMs: 10,
  maxRecentMessages: 30,
  noProgressTokenThreshold: 25,
  noProgressTurnsBeforePause: 3,
  noToolCallTurnsBeforePause: 0,
  budgetWrapupRatio: 0.75,
  warnTurnsRemaining: 2,
  warnDurationMsRemaining: 10_000,
  warnTokensRemaining: 5_000,
  maxPromptFailures: 2,
  persistState: false,
  stateFilePath: "/tmp/goals.json",
  ledgerFilePath: "/tmp/goals.ledger.jsonl",
  ledgerMaxBytes: 1_000_000,
  ledgerRetentionFiles: 2,
  resultRetentionMs: 10_000,
  maxStoredResults: 20,
  commandName: "objective",
  registerCommand: true,
  registerTools: true,
  registerAgents: true,
  goalAgentName: "objective",
  verifierAgentName: "objective-check",
  completionAudit: true,
  auditorOptions: { timeoutMs: 5_000, failurePolicy: "reject" },
  auditMessages: true,
  auditMessenger: (_sessionID, _text) => {},
  auditor: async ({ goal, sessionID, latestText }: CompletionAuditContext) => ({
    approved: goal.sessionID === sessionID && latestText.length > 0,
    reason: goal.lastCheckpoint?.summary,
  }),
} satisfies GoalPluginOptions

const hooks: GoalPluginHooks = await GoalPlugin({ client: {}, directory: "/tmp" }, options)
hooks.config({})
hooks.event({})
hooks["experimental.chat.system.transform"]({}, {})
hooks["tool.execute.before"]({}, {})
hooks["experimental.compaction.autocontinue"]({}, {})
hooks["experimental.session.compacting"]({}, {})
await hooks.dispose()

const sameServer: typeof GoalPlugin = goalPlugin.server
const sameExport: typeof goalPlugin = serverPlugin
void sameServer
void sameExport

// @ts-expect-error unknown hooks must not be hidden by an index signature
hooks["experimental.missing.hook"]
// @ts-expect-error invalid SDK shapes must be rejected by consumers
const invalid: GoalPluginOptions = { sdkShape: "automatic" }
void invalid
`

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(consumerDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
  ])
  await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }))
  await writeFile(join(consumerDirectory, "contract.ts"), fixture)

  const packResult = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", packDirectory],
    { cwd: repository, encoding: "utf8", env: npmEnvironment },
  ))
  assert.equal(packResult.length, 1)
  const tarball = join(packDirectory, packResult[0].filename)
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--omit=peer", "--offline", "--cache", cacheDirectory, tarball],
    { cwd: consumerDirectory, stdio: "pipe", env: npmEnvironment },
  )

  const common = ["--strict", "--noEmit", "--target", "ES2022", "--skipLibCheck", "false", "contract.ts"]
  execFileSync(process.execPath, [tsc, "--module", "NodeNext", "--moduleResolution", "NodeNext", ...common], {
    cwd: consumerDirectory,
    stdio: "pipe",
  })
  execFileSync(process.execPath, [tsc, "--module", "ESNext", "--moduleResolution", "Bundler", ...common], {
    cwd: consumerDirectory,
    stdio: "pipe",
  })
  console.log(`type contract passed (NodeNext + Bundler; ${packResult[0].filename})`)
} finally {
  await rm(root, { recursive: true, force: true })
}
