import assert from "node:assert/strict"
import pluginModule, { GoalPlugin } from "opencode-goal-plugin"

const expectedTools = [
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

const sessionID = `smoke-${Date.now()}`
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

assert.equal(pluginModule.id, "opencode-goal-plugin")
assert.equal(pluginModule.server, GoalPlugin)

// persistState:false keeps the smoke test from reading or overwriting the
// user's real ~/.opencode-goal-plugin/state.json.
const hooks = await GoalPlugin({ client }, { minDelayMs: 1, persistState: false })
assert.equal(typeof hooks["command.execute.before"], "function")
assert.equal(typeof hooks.event, "function")
assert.equal(typeof hooks["experimental.chat.system.transform"], "function")
assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), expectedTools)
for (const name of expectedTools) {
  assert.equal(typeof hooks.tool[name].execute, "function", `${name} must be executable`)
}

const commandHook = hooks["command.execute.before"]
let commandMessageCounter = 0

async function runGoalCommand(args) {
  // OpenCode keeps this array after command.execute.before returns. The hook
  // must mutate it in place rather than only replacing the wrapper property.
  const hostParts = [{ type: "text", text: args }]
  commandMessageCounter += 1
  const messageID = `smoke-command-${commandMessageCounter}`
  const output = {
    message: { id: messageID, role: "user", sessionID },
    parts: hostParts,
  }
  await commandHook({ command: "goal", sessionID, arguments: args }, output)
  assert.strictEqual(output.parts, hostParts)
  assert.equal(hostParts.length, 1)
  assert.equal(hostParts[0].type, "text")
  assert.equal(hostParts[0].synthetic, true)
  assert.equal(hostParts[0].metadata?.["opencode-goal-plugin"]?.kind, "command")
  assert.match(hostParts[0].metadata?.["opencode-goal-plugin"]?.id, /^[0-9a-f-]{36}$/)
  // OpenCode resolves the retained inputs into persisted parts before
  // chat.message, stamping each one with the generated user message/session.
  output.parts = hostParts.map((part, index) => ({
    ...part,
    id: `smoke-command-part-${commandMessageCounter}-${index}`,
    messageID,
    sessionID,
  }))
  await hooks["chat.message"](
    { sessionID, messageID, agent: "build", model: { providerID: "test", modelID: "test" } },
    output,
  )
  return output.parts[0].text
}

assert.match(await runGoalCommand("status"), /No active goal/)
assert.match(await runGoalCommand("ship a smoke test --max-turns 1"), /New active goal/)
const activeStatus = await runGoalCommand("status")
assert.match(activeStatus, /Active goal: ship a smoke test/)
assert.doesNotMatch(activeStatus, /State: Paused/)
assert.match(await runGoalCommand("clear"), /Goal cleared/)
assert.match(await runGoalCommand("status"), /No active goal/)
assert.equal(promptCalls.length, 0)
assert.equal(logCalls.length, 0)

console.log("opencode-goal-plugin command hook smoke passed")
