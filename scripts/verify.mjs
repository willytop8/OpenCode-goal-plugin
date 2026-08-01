#!/usr/bin/env node
// Installation verification for opencode-goal-plugin.
// Checks the plugin can be loaded and wired up correctly without ever
// invoking a model — every check below uses the same mock-client approach
// as scripts/smoke-command-hook.mjs.

import assert from "node:assert/strict"

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
  assert.doesNotMatch(statusText, /State: Paused/)
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
