import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { GoalPlugin, testInternals } from "../src/goal-plugin.js"

function assistantMessage(sessionID, text = "Still working.") {
  return {
    info: {
      id: `assistant-${sessionID}`,
      role: "assistant",
      sessionID,
      tokens: { input: 10, output: 100, reasoning: 0 },
    },
    parts: [{ type: "text", text }],
  }
}

function hostClient({ messages, promptAsync } = {}) {
  return {
    app: { log: async () => {} },
    session: {
      messages:
        messages ||
        (async ({ path }) => ({ data: [assistantMessage(path.id)] })),
      promptAsync: promptAsync || (async () => ({})),
    },
  }
}

async function createPlugin(client, directory) {
  return GoalPlugin(
    { client, directory },
    {
      persistState: false,
      registerTools: false,
      minDelayMs: 1,
      noToolCallTurnsBeforePause: 10,
    },
  )
}

async function setGoal(hooks, sessionID, objective) {
  const output = { parts: [] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: objective },
    output,
  )
  return output
}

async function goalStatus(hooks, sessionID) {
  const output = { parts: [] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: "status" },
    output,
  )
  return output.parts[0]?.text || ""
}

async function idle(hooks, sessionID) {
  await hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID, status: { type: "idle" } },
    },
  })
}

test("initializing a second workspace does not clear or take ownership of the first workspace", async () => {
  const firstCalls = []
  const first = await createPlugin(
    hostClient({
      promptAsync: async (input) => {
        firstCalls.push(input)
        return {}
      },
    }),
    "/workspace/one",
  )
  await setGoal(first, "session-one", "finish workspace one")

  const secondCalls = []
  const second = await createPlugin(
    hostClient({
      promptAsync: async (input) => {
        secondCalls.push(input)
        return {}
      },
    }),
    "/workspace/two",
  )
  await setGoal(second, "session-two", "finish workspace two")

  assert.match(await goalStatus(first, "session-one"), /finish workspace one/)
  assert.match(await goalStatus(second, "session-two"), /finish workspace two/)

  await idle(first, "session-one")
  await idle(second, "session-two")
  assert.equal(firstCalls.length, 1)
  assert.equal(secondCalls.length, 1)
})

test("session.created never copies an active goal into a child or fork-like session", async () => {
  const hooks = await createPlugin(hostClient(), "/workspace/session-created")
  await setGoal(hooks, "parent-session", "keep this goal private to the parent")

  await hooks.event({
    event: {
      type: "session.created",
      properties: {
        sessionID: "child-session",
        info: {
          id: "child-session",
          parentID: "parent-session",
          title: "Child session",
        },
      },
    },
  })
  await hooks.event({
    event: {
      type: "session.created",
      properties: {
        sessionID: "fork-session",
        info: {
          id: "fork-session",
          // OpenCode currently omits parentID for forks. A title is not a
          // trustworthy relationship contract and must not trigger copying.
          title: "Parent session (fork #1)",
        },
      },
    },
  })

  assert.match(await goalStatus(hooks, "parent-session"), /keep this goal private/)
  assert.match(await goalStatus(hooks, "child-session"), /No active goal/i)
  assert.match(await goalStatus(hooks, "fork-session"), /No active goal/i)
})

test("idle in a fork-like session cannot continue its parent's goal", async () => {
  const promptCalls = []
  const hooks = await createPlugin(
    hostClient({
      promptAsync: async (input) => {
        promptCalls.push(input)
        return {}
      },
    }),
    "/workspace/fork-isolation",
  )
  await setGoal(hooks, "parent-session", "continue only in the parent")

  await hooks.event({
    event: {
      type: "session.created",
      properties: {
        sessionID: "fork-session",
        info: { id: "fork-session", title: "Parent session (fork #1)" },
      },
    },
  })
  await idle(hooks, "fork-session")

  assert.equal(promptCalls.length, 0)
})

test("MessageAbortedError followed by idle does not restart autonomous work", async () => {
  const promptCalls = []
  const hooks = await createPlugin(
    hostClient({
      promptAsync: async (input) => {
        promptCalls.push(input)
        return {}
      },
    }),
    "/workspace/abort",
  )
  const sessionID = "session-aborted"
  await setGoal(hooks, sessionID, "do not continue after escape")

  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID,
        error: { name: "MessageAbortedError", message: "The operation was aborted" },
      },
    },
  })
  await idle(hooks, sessionID)

  assert.equal(promptCalls.length, 0)
  assert.match(await goalStatus(hooks, sessionID), /abort|paused|stopped/i)
})

test("plugin continuation prompt is synthetic and carries namespaced metadata", async () => {
  const promptCalls = []
  const hooks = await createPlugin(
    hostClient({
      promptAsync: async (input) => {
        promptCalls.push(input)
        return {}
      },
    }),
    "/workspace/synthetic",
  )
  const sessionID = "session-synthetic"
  await setGoal(hooks, sessionID, "continue safely")
  await idle(hooks, sessionID)

  assert.equal(promptCalls.length, 1)
  const part = promptCalls[0].body.parts[0]
  assert.equal(part.type, "text")
  assert.equal(part.synthetic, true)
  assert.deepEqual(part.metadata, {
    "opencode-goal-plugin": { kind: "continuation" },
  })
})

test("dispose prevents a delayed idle continuation from reaching the host", async () => {
  const promptCalls = []
  const hooks = await createPlugin(
    hostClient({
      promptAsync: async (input) => {
        promptCalls.push(input)
        return {}
      },
    }),
    "/workspace/dispose",
  )
  const sessionID = "session-disposed"
  await setGoal(hooks, sessionID, "stop when plugin unloads")

  assert.equal(typeof hooks.dispose, "function", "plugin must expose a host disposal hook")
  await hooks.dispose()
  await idle(hooks, sessionID)

  assert.equal(promptCalls.length, 0)
})

test("resuming keeps stable goal identity and invalidates the prior run epoch", async () => {
  const hooks = await createPlugin(hostClient(), "/workspace/resume-identity")
  const sessionID = "session-resume-identity"
  await setGoal(hooks, sessionID, "resume without corrupting registry")

  const before = testInternals.currentGoal(sessionID)
  const goalID = before.goalId
  const runID = before.runId

  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: "pause" },
    { parts: [] },
  )
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: "resume" },
    { parts: [] },
  )

  const after = testInternals.currentGoal(sessionID)
  assert.equal(after.goalId, goalID)
  assert.notEqual(after.runId, runID)
  assert.equal(testInternals.listSessionGoals(sessionID).length, 1)
})

test("disposing one workspace leaves another workspace active", async () => {
  const first = await createPlugin(hostClient(), "/workspace/dispose-one")
  await setGoal(first, "session-dispose-one", "keep first alive")
  const second = await createPlugin(hostClient(), "/workspace/dispose-two")
  await setGoal(second, "session-dispose-two", "dispose second only")

  await second.dispose()

  assert.match(await goalStatus(first, "session-dispose-one"), /keep first alive/)
  assert.match(await goalStatus(second, "session-dispose-two"), /No active goal/)
})

test("workspace persistence and lifecycle ledgers remain isolated", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "goal-plugin-workspaces-"))
  const firstDirectory = join(root, "one")
  const secondDirectory = join(root, "two")
  await fs.mkdir(firstDirectory, { recursive: true })
  await fs.mkdir(secondDirectory, { recursive: true })

  const first = await GoalPlugin(
    { client: hostClient(), directory: firstDirectory },
    { registerTools: false },
  )
  await setGoal(first, "session-persist-one", "persist only workspace one")

  const second = await GoalPlugin(
    { client: hostClient(), directory: secondDirectory },
    { registerTools: false },
  )
  await setGoal(second, "session-persist-two", "persist only workspace two")

  const firstState = JSON.parse(
    await fs.readFile(join(firstDirectory, ".opencode", "goals", "state.json"), "utf8"),
  )
  const secondState = JSON.parse(
    await fs.readFile(join(secondDirectory, ".opencode", "goals", "state.json"), "utf8"),
  )
  assert.deepEqual(firstState.goals.map((goal) => goal.sessionID), ["session-persist-one"])
  assert.deepEqual(secondState.goals.map((goal) => goal.sessionID), ["session-persist-two"])

  const firstLedger = await fs.readFile(
    join(firstDirectory, ".opencode", "goals", "state.json.ledger.jsonl"),
    "utf8",
  )
  const secondLedger = await fs.readFile(
    join(secondDirectory, ".opencode", "goals", "state.json.ledger.jsonl"),
    "utf8",
  )
  assert.match(firstLedger, /session-persist-one/)
  assert.doesNotMatch(firstLedger, /session-persist-two/)
  assert.match(secondLedger, /session-persist-two/)
  assert.doesNotMatch(secondLedger, /session-persist-one/)
})
