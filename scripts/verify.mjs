#!/usr/bin/env node
// Installation verification for opencode-goal-plugin.
// Checks the plugin can be loaded and wired up correctly without ever
// invoking a model — every check below uses the same mock-client approach
// as scripts/smoke-command-hook.mjs.

import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const REQUIRED_HOOKS = [
  "config",
  "chat.params",
  "chat.message",
  "command.execute.before",
  "tool.execute.before",
  "event",
  "experimental.chat.system.transform",
  "experimental.compaction.autocontinue",
  "experimental.session.compacting",
]

const EXPECTED_TOOLS = [
  "clear_goal",
  "get_goal",
  "get_goal_history",
  "goal_block",
  "goal_complete",
  "goal_pause",
  "goal_resume",
  "goal_set",
  "goal_status",
  "set_goal",
  "update_goal",
]

const results = []

class VerificationWarning extends Error {}

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true })
      console.log(`  ✅ ${name}`)
    })
    .catch((error) => {
      if (!(error instanceof VerificationWarning)) throw error
      results.push({ name, ok: true, warning: error.message })
      console.log(`  ⚠️  ${name}`)
      console.log(`     ${error.message}`)
    })
    .catch((error) => {
      results.push({ name, ok: false, error })
      console.log(`  ❌ ${name}`)
      console.log(`     ${error.message}`)
    })
}

console.log("opencode-goal-plugin installation verification\n")

await check("Node.js >= 18", () => {
  const major = Number(process.versions.node.split(".")[0])
  assert.ok(major >= 18, `Node ${process.versions.node} is below the required >=18`)
})

let pluginModule
let GoalPlugin

await check("plugin module resolves and exposes expected shape", async () => {
  pluginModule = await import("opencode-goal-plugin")
  GoalPlugin = pluginModule.GoalPlugin
  assert.equal(pluginModule.default.id, "opencode-goal-plugin")
  assert.equal(typeof pluginModule.default.server, "function")
  assert.equal(typeof GoalPlugin, "function")
})

const sessionID = `verify-${process.pid}`
const promptCalls = []
const logCalls = []

const client = {
  app: {
    log: async (input) => {
      logCalls.push(input)
    },
  },
  session: {
    messages: async () => ({ data: [] }),
    promptAsync: async (input) => {
      promptCalls.push(input)
      return {}
    },
  },
}

let hooks
let commandMessageCounter = 0

await check(`plugin initializes and registers all ${REQUIRED_HOOKS.length} required hooks`, async () => {
  hooks = await GoalPlugin({ client }, { minDelayMs: 1, persistState: false })
  for (const hookName of REQUIRED_HOOKS) {
    assert.equal(
      typeof hooks[hookName],
      "function",
      `missing or non-function hook: ${hookName}`,
    )
  }
  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), EXPECTED_TOOLS)
  for (const name of EXPECTED_TOOLS) {
    assert.equal(typeof hooks.tool[name].execute, "function", `${name} must be executable`)
  }
})

async function runGoalCommand(args) {
  // Match OpenCode's host contract: it retains this exact array after the hook
  // returns, so replacing output.parts would leave the raw command untouched.
  const hostParts = [{ type: "text", text: args }]
  commandMessageCounter += 1
  const messageID = `verify-command-${commandMessageCounter}`
  const output = {
    message: { id: messageID, role: "user", sessionID },
    parts: hostParts,
  }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: args },
    output,
  )
  assert.strictEqual(output.parts, hostParts)
  assert.equal(hostParts.length, 1)
  assert.equal(hostParts[0].type, "text")
  assert.equal(hostParts[0].synthetic, true)
  assert.equal(hostParts[0].metadata?.["opencode-goal-plugin"]?.kind, "command")
  assert.match(hostParts[0].metadata?.["opencode-goal-plugin"]?.id, /^[0-9a-f-]{36}$/)
  output.parts = hostParts.map((part, index) => ({
    ...part,
    id: `verify-command-part-${commandMessageCounter}-${index}`,
    messageID,
    sessionID,
  }))
  await hooks["chat.message"](
    { sessionID, messageID, agent: "build", model: { providerID: "test", modelID: "test" } },
    output,
  )
  return output.parts[0].text
}

await check("/goal status works", async () => {
  const text = await runGoalCommand("status")
  assert.match(text, /No active goal/)
})

await check("/goal set works", async () => {
  const text = await runGoalCommand("verify the installation --max-turns 1")
  assert.match(text, /New active goal: verify the installation/)
  const statusText = await runGoalCommand("status")
  assert.match(statusText, /Active goal: verify the installation/)
  assert.match(statusText, /State: active/)
  assert.match(statusText, /Completion audit: evidence gate only \(independent verifier off\)/)
})

await check("no model calls were made during verification", () => {
  assert.equal(promptCalls.length, 0, "expected zero promptAsync calls")
})

// Clean up the goal created above so this script has no side effects.
await runGoalCommand("clear")

await check("lifecycle transitions are visible without leaking objective text", () => {
  assert.deepEqual(logCalls.map((entry) => entry.body.extra.kind), ["goal-lifecycle", "goal-lifecycle"])
  assert.match(logCalls[0].body.message, /Goal (?:active|started)/i)
  assert.match(logCalls[1].body.message, /Goal cleared/i)
  assert.ok(logCalls.every((entry) => !entry.body.message.includes("verify the installation")))
})

// OpenCode installs an unpinned plugin into its package cache once and never
// re-resolves `latest` while that directory exists, so a user can run a stale
// copy long after upgrading on npm. Warn (never fail) when the unpinned cache
// entries lag the package this script came from.
function installedPackageVersion() {
  try {
    let dir = dirname(createRequire(import.meta.url).resolve("opencode-goal-plugin"))
    while (dir !== dirname(dir)) {
      const pkg = join(dir, "package.json")
      if (existsSync(pkg)) {
        const json = JSON.parse(readFileSync(pkg, "utf8"))
        if (json.name === "opencode-goal-plugin") return String(json.version || "")
      }
      dir = dirname(dir)
    }
  } catch {}
  return ""
}

function versionBelow(a, b) {
  const parse = (v) => String(v).split("-")[0].split(".").map((n) => Number(n) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0)
  }
  return false
}

await check("OpenCode's cached copy of the plugin is not older than this package", () => {
  const packageVersion = installedPackageVersion()
  if (!packageVersion) return
  const cacheRoots = [
    process.env.XDG_CACHE_HOME ? join(process.env.XDG_CACHE_HOME, "opencode") : null,
    join(homedir(), ".cache", "opencode"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "opencode") : null,
  ].filter(Boolean)
  const stale = []
  for (const root of cacheRoots) {
    const packages = join(root, "packages")
    if (!existsSync(packages)) continue
    for (const entry of readdirSync(packages)) {
      // Only unpinned entries are affected; a pinned older version is a choice.
      if (entry !== "opencode-goal-plugin" && entry !== "opencode-goal-plugin@latest") continue
      const pkg = join(packages, entry, "node_modules", "opencode-goal-plugin", "package.json")
      if (!existsSync(pkg)) continue
      let cached = ""
      try {
        cached = String(JSON.parse(readFileSync(pkg, "utf8")).version || "")
      } catch {
        continue
      }
      if (cached && versionBelow(cached, packageVersion)) stale.push({ path: join(packages, entry), cached })
    }
  }
  if (!stale.length) return
  throw new VerificationWarning(
    `OpenCode is running ${stale.map((s) => `${s.cached} from ${s.path}`).join(" and ")}, older than ${packageVersion}. ` +
      `OpenCode never re-resolves an unpinned plugin: pin "opencode-goal-plugin@${packageVersion}" in opencode.json, ` +
      "or delete that cache directory, then restart OpenCode.",
  )
})

console.log()

const failed = results.filter((r) => !r.ok)
if (failed.length > 0) {
  console.log(`${failed.length}/${results.length} checks failed.`)
  process.exit(1)
}

const warnings = results.filter((r) => r.warning).length
console.log(
  `All ${results.length} checks passed${warnings ? ` with ${warnings} warning(s)` : ""}. opencode-goal-plugin is installed correctly.`,
)
