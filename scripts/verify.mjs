#!/usr/bin/env node
// Installation verification for opencode-goal-plugin.
// Checks the plugin can be loaded and wired up correctly without ever
// invoking a model — every check below uses the same mock-client approach
// as scripts/smoke-command-hook.mjs.

import assert from "node:assert/strict"

const REQUIRED_HOOKS = [
  "command.execute.before",
  "event",
  "experimental.chat.system.transform",
  "experimental.compaction.autocontinue",
]

const results = []

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true })
      console.log(`  ✅ ${name}`)
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

await check("plugin initializes and registers all 4 required hooks", async () => {
  // registerTools defaults to true but silently no-ops without the optional
  // @opencode-ai/plugin peer dependency, so it is not asserted here — the
  // 4 hooks below are always present regardless of that peer dependency.
  hooks = await GoalPlugin({ client }, { minDelayMs: 1, persistState: false })
  for (const hookName of REQUIRED_HOOKS) {
    assert.equal(
      typeof hooks[hookName],
      "function",
      `missing or non-function hook: ${hookName}`,
    )
  }
})

async function runGoalCommand(args) {
  const output = { parts: [] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: args },
    output,
  )
  assert.equal(output.parts.length, 1)
  assert.equal(output.parts[0].type, "text")
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
})

await check("no model calls were made during verification", () => {
  assert.equal(promptCalls.length, 0, "expected zero promptAsync calls")
})

// Clean up the goal created above so this script has no side effects.
await runGoalCommand("clear")

console.log()

const failed = results.filter((r) => !r.ok)
if (failed.length > 0) {
  console.log(`${failed.length}/${results.length} checks failed.`)
  process.exit(1)
}

console.log(`All ${results.length} checks passed. opencode-goal-plugin is installed correctly.`)
