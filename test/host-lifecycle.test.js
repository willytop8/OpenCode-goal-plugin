import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { GoalPlugin, testInternals } from "../src/goal-plugin.js"

function sessionPaths(stateFilePath, sessionID) {
  return testInternals.sessionPathsFor({ sessionDirectory: `${stateFilePath}.sessions` }, sessionID)
}

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

let commandMessageCounter = 0
async function acceptCommandTurn(hooks, sessionID, output) {
  commandMessageCounter += 1
  const messageID = `command-user-${commandMessageCounter}`
  output.message = { id: messageID, role: "user", sessionID }
  for (const [index, part] of output.parts.entries()) {
    Object.assign(part, {
      id: part.id || `command-part-${commandMessageCounter}-${index}`,
      messageID,
      sessionID,
    })
  }
  await hooks["chat.message"](
    { sessionID, messageID, agent: "build" },
    output,
  )
  return messageID
}

async function finishControlTurn(
  hooks,
  sessionID,
  parentID,
  text = "Reported.",
  observeAssistant,
) {
  const info = {
    id: `command-assistant-${parentID}`,
    parentID,
    role: "assistant",
    sessionID,
    tokens: { input: 5, output: 5, reasoning: 0 },
  }
  observeAssistant?.({ info, parts: [{ type: "text", text }] })
  await hooks.event({
    event: {
      type: "message.updated",
      properties: { info },
    },
  })
  await idle(hooks, sessionID)
}

async function readMaybe(path) {
  try {
    return await fs.readFile(path, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function assertNoLeaseOwner(lockPath) {
  const claims = (await fs.readdir(`${lockPath}.claims-v2`))
    .filter((name) => name.startsWith("claim-"))
  assert.deepEqual(claims, [])
  const legacyGuard = await readMaybe(lockPath)
  if (legacyGuard !== null) {
    assert.equal(JSON.parse(legacyGuard).sentinel, true)
  }
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
  assert.equal(part.metadata["opencode-goal-plugin"].kind, "continuation")
  assert.match(part.metadata["opencode-goal-plugin"].id, /^[0-9a-f-]{36}$/)
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

test("dispose wins goal command and tool continuations that already received an active load result", async () => {
  const hooks = await GoalPlugin(
    { client: hostClient() },
    { persistState: false, minDelayMs: 1 },
  )
  const parts = [{ type: "text", text: "host-owned sentinel" }]
  const output = { parts }

  const command = hooks["command.execute.before"](
    { command: "goal", sessionID: "dispose-control-race", arguments: "must not run" },
    output,
  )
  const toolCall = hooks.tool.goal_set.execute(
    { objective: "must not run from tool" },
    { sessionID: "dispose-control-race" },
  )
  const disposing = hooks.dispose()

  await Promise.all([command, disposing])
  const toolResult = JSON.parse(await toolCall)
  assert.strictEqual(output.parts, parts)
  assert.deepEqual(output.parts, [{ type: "text", text: "host-owned sentinel" }])
  assert.equal(toolResult.ok, false)
  assert.equal(toolResult.error, "plugin_disposed")
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
  assert.equal(await goalStatus(second, "session-dispose-two"), "")
})

test("disposed instance cannot persist over a replacement instance after a late prompt", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "goal-plugin-late-dispose-"))
  let releasePrompt
  let promptStarted
  const started = new Promise((resolve) => { promptStarted = resolve })
  const pendingPrompt = new Promise((resolve) => { releasePrompt = resolve })
  const firstClient = hostClient({
    promptAsync: async () => {
      promptStarted()
      await pendingPrompt
      return {}
    },
  })
  let first
  let second
  try {
    first = await GoalPlugin(
      { client: firstClient, directory },
      { registerTools: false, minDelayMs: 1, noToolCallTurnsBeforePause: 10 },
    )
    await setGoal(first, "late-session", "old objective")
    const oldIdle = idle(first, "late-session")
    await started
    await first.dispose()
    first = null

    second = await GoalPlugin(
      { client: hostClient(), directory },
      { registerTools: false, minDelayMs: 1, noToolCallTurnsBeforePause: 10 },
    )
    await setGoal(second, "late-session", "replacement objective")
    releasePrompt()
    await oldIdle

    const raw = JSON.parse(
      await fs.readFile(
        sessionPaths(join(directory, ".opencode", "goals", "state.json"), "late-session").stateFilePath,
        "utf8",
      ),
    )
    assert.deepEqual(raw.goals.map((goal) => goal.condition), ["replacement objective"])
  } finally {
    releasePrompt?.()
    await first?.dispose()
    await second?.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a same-session contender stays passive across chat, commands, hooks, and control security", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "goal-plugin-passive-hooks-"))
  const stateFilePath = join(directory, "state.json")
  const sessionID = "passive-hooks-session"
  const paths = sessionPaths(stateFilePath, sessionID)
  const logs = []
  const messagesCalls = []
  const promptCalls = []
  let hostMessages = []
  let owner
  let contender
  try {
    owner = await GoalPlugin(
      { client: hostClient(), directory },
      { stateFilePath, minDelayMs: 1, noToolCallTurnsBeforePause: 10 },
    )
    await setGoal(owner, sessionID, "owner objective")
    const stateBefore = await fs.readFile(paths.stateFilePath, "utf8")
    const ledgerBefore = await readMaybe(paths.ledgerFilePath)
    const lockBefore = await fs.readFile(`${paths.stateFilePath}.lock`, "utf8")

    contender = await GoalPlugin(
      {
        client: {
          app: { log: async (input) => logs.push(input) },
          session: {
            messages: async (input) => {
              messagesCalls.push(input)
              return { data: hostMessages }
            },
            promptAsync: async (input) => {
              promptCalls.push(input)
              return {}
            },
          },
        },
        directory,
      },
      {
        stateFilePath,
        commandName: "objective",
        minDelayMs: 1,
        noToolCallTurnsBeforePause: 10,
      },
    )

    await contender["chat.params"]({
      sessionID,
      agent: "build",
      model: { providerID: "test", modelID: "ordinary" },
    })
    const ordinaryParts = [{ type: "text", text: "ordinary chat must remain unchanged" }]
    const ordinaryOutput = {
      message: { id: "ordinary-user", role: "user", sessionID },
      parts: ordinaryParts,
    }
    await contender["chat.message"](
      { sessionID, messageID: "ordinary-user", agent: "build" },
      ordinaryOutput,
    )
    assert.strictEqual(ordinaryOutput.parts, ordinaryParts)
    assert.equal(ordinaryOutput.parts[0].text, "ordinary chat must remain unchanged")
    await assert.doesNotReject(() =>
      contender["tool.execute.before"]({ sessionID, tool: "read" }),
    )

    const systemOutput = { system: ["base system"] }
    await contender["experimental.chat.system.transform"]({ sessionID }, systemOutput)
    assert.deepEqual(systemOutput, { system: ["base system"] })
    const compactOutput = { context: ["base context"] }
    await contender["experimental.session.compacting"]({ sessionID }, compactOutput)
    assert.deepEqual(compactOutput, { context: ["base context"] })
    const autoOutput = { enabled: true }
    await contender["experimental.compaction.autocontinue"]({ sessionID }, autoOutput)
    assert.deepEqual(autoOutput, { enabled: true })
    await contender.event({
      event: {
        type: "session.updated",
        properties: { sessionID, info: { agent: "build" } },
      },
    })
    await idle(contender, sessionID)

    const commandForms = [
      "",
      "status",
      "history",
      "list",
      "pause",
      "clear",
      "stop",
      "off",
      "reset",
      "none",
      "cancel",
      "resume",
      "edit private revised objective",
      "focus 1",
      "add private background objective",
      "sequence private alpha; private beta",
      "sisyphus private alpha; private beta",
      "private replacement objective",
    ]
    for (const args of commandForms) {
      const retained = [
        { type: "text", text: args },
        { type: "file", url: "file:///private/proof.txt", mime: "text/plain" },
      ]
      const output = { parts: retained }
      await contender["command.execute.before"](
        { command: "objective", sessionID, arguments: args },
        output,
      )
      assert.strictEqual(output.parts, retained)
      assert.equal(output.parts.length, 1)
      assert.equal(output.parts[0].synthetic, true)
      assert.match(output.parts[0].text, /Goal controls are unavailable/)
      assert.match(output.parts[0].text, /\/objective status/)
      assert.doesNotMatch(output.parts[0].text, /private (?:revised|background|replacement|alpha|beta)/)
      assert.doesNotMatch(output.parts[0].text, /file:\/\/|state\.json|pid \d+/i)
      const parentID = await acceptCommandTurn(contender, sessionID, output)
      if (args === commandForms[0]) {
        await idle(contender, sessionID)
        await assert.rejects(
          contender["tool.execute.before"]({ sessionID, tool: "write" }),
          /no tool calls are allowed/i,
        )
      }
      await assert.rejects(
        contender["tool.execute.before"]({ sessionID, tool: "goal_set" }),
        /no tool calls are allowed/i,
      )
      const guardedSystem = { system: [] }
      await contender["experimental.chat.system.transform"](
        { sessionID },
        guardedSystem,
      )
      assert.equal(guardedSystem.system.length, 1)
      assert.match(guardedSystem.system[0], /control-command/)
      assert.doesNotMatch(guardedSystem.system[0], /owner objective|pid \d+|state\.json/i)
      await finishControlTurn(
        contender,
        sessionID,
        parentID,
        "Reported.",
        (message) => { hostMessages = [message] },
      )
      await assert.doesNotReject(() =>
        contender["tool.execute.before"]({ sessionID, tool: "read" }),
      )
    }

    assert.ok(messagesCalls.length >= commandForms.length + 1)
    assert.equal(promptCalls.length, 0)
    assert.equal(logs.length, 1)
    assert.equal(logs[0].body.level, "warn")
    assert.match(logs[0].body.message, /Ordinary chat remains available/)
    assert.doesNotMatch(logs[0].body.message, /state\.json|token/i)
    assert.equal(await fs.readFile(paths.stateFilePath, "utf8"), stateBefore)
    assert.equal(await readMaybe(paths.ledgerFilePath), ledgerBefore)
    assert.equal(await fs.readFile(`${paths.stateFilePath}.lock`, "utf8"), lockBefore)
  } finally {
    await contender?.dispose()
    await owner?.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("legacy or incomplete leases stay passive with actionable manual recovery", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "goal-plugin-passive-legacy-lock-"))
  const stateFilePath = join(directory, "state.json")
  const sessionID = "passive-legacy-lock-session"
  const paths = sessionPaths(stateFilePath, sessionID)
  const persistedState = JSON.stringify({
    version: 1,
    goals: [{
      sessionID,
      condition: "private legacy objective must not be loaded",
      startedAt: Date.now(),
      options: {},
    }],
    results: [],
  })
  const logs = []
  let hooks
  try {
    await fs.mkdir(dirname(paths.stateFilePath), { recursive: true })
    await fs.writeFile(paths.stateFilePath, persistedState)
    await fs.mkdir(`${paths.stateFilePath}.lock`)
    await fs.writeFile(
      `${paths.stateFilePath}.lock/owner.json`,
      JSON.stringify({ token: "legacy-owner", pid: 4242, hostname: "legacy.remote.example" }),
    )

    hooks = await GoalPlugin(
      {
        client: {
          ...hostClient(),
          app: { log: async (entry) => logs.push(entry) },
        },
        directory,
      },
      { stateFilePath, minDelayMs: 1 },
    )
    await hooks["chat.params"]({ sessionID, agent: "build" })

    assert.equal(testInternals.currentGoal(sessionID), null)
    assert.equal(await fs.readFile(paths.stateFilePath, "utf8"), persistedState)

    const status = JSON.parse(
      await hooks.tool.goal_status.execute({}, { sessionID, agent: "build" }),
    )
    assert.equal(status.ok, false)
    assert.equal(status.error, "session_owned_elsewhere")
    assert.match(status.message, /older or incomplete persistence lease/i)
    assert.match(status.message, /remove only the affected session shard's adjacent lease artifacts/i)
    assert.doesNotMatch(status.message, /private legacy objective|state\.json|legacy\.remote/i)

    const command = { parts: [] }
    await hooks["command.execute.before"](
      { command: "goal", sessionID, arguments: "status" },
      command,
    )
    assert.match(command.parts[0].text, /older or incomplete persistence lease/i)
    assert.equal(logs.length, 1)
    assert.match(logs[0].body.message, /older release or is incomplete/i)
    assert.doesNotMatch(logs[0].body.message, /state\.json|legacy\.remote/i)
  } finally {
    await hooks?.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("passive goal tools reject honestly, remain per-session, and take over paused", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "goal-plugin-passive-tools-"))
  const stateFilePath = join(directory, "state.json")
  const sessionID = "passive-tools-session"
  const otherSessionID = "passive-tools-other-session"
  const paths = sessionPaths(stateFilePath, sessionID)
  const logs = []
  const messagesCalls = []
  const promptCalls = []
  let hostMessages = []
  let owner
  let contender
  try {
    owner = await GoalPlugin(
      { client: hostClient(), directory },
      { stateFilePath, minDelayMs: 1, noToolCallTurnsBeforePause: 10 },
    )
    await setGoal(owner, sessionID, "durable owner objective")
    const stateBefore = await fs.readFile(paths.stateFilePath, "utf8")
    const ledgerBefore = await readMaybe(paths.ledgerFilePath)

    contender = await GoalPlugin(
      {
        client: {
          app: { log: async (input) => logs.push(input) },
          session: {
            messages: async (input) => {
              messagesCalls.push(input)
              return { data: hostMessages }
            },
            promptAsync: async (input) => {
              promptCalls.push(input)
              return {}
            },
          },
        },
        directory,
      },
      {
        stateFilePath,
        commandName: "objective",
        minDelayMs: 1,
        noToolCallTurnsBeforePause: 10,
      },
    )

    const passiveCommand = { parts: [] }
    await contender["command.execute.before"](
      { command: "objective", sessionID, arguments: "status" },
      passiveCommand,
    )
    const oldCommandParentID = await acceptCommandTurn(
      contender,
      sessionID,
      passiveCommand,
    )
    await finishControlTurn(
      contender,
      sessionID,
      oldCommandParentID,
      "Reported.",
      (message) => { hostMessages = [message] },
    )

    const canonical = [
      ["goal_status", {}, "status"],
      ["goal_set", { objective: "must not replace" }, "set"],
      ["goal_pause", {}, "pause"],
      ["goal_resume", {}, "resume"],
      ["goal_block", { blocker: "must not block" }, "block"],
      ["goal_complete", { summary: "must not complete" }, "complete"],
    ]
    for (const [name, args, operation] of canonical) {
      const result = JSON.parse(await contender.tool[name].execute(args, { sessionID }))
      assert.deepEqual(
        { version: result.version, operation: result.operation, ok: result.ok, error: result.error },
        { version: 1, operation, ok: false, error: "session_owned_elsewhere" },
      )
      assert.match(result.message, /Goal controls are unavailable/)
      assert.match(result.message, /\/objective status/)
    }

    const legacy = [
      ["get_goal", {}],
      ["get_goal_history", {}],
      ["set_goal", { objective: "must not replace" }],
      ["update_goal", { status: "complete", evidence: "must not complete" }],
      ["clear_goal", {}],
    ]
    for (const [name, args] of legacy) {
      const result = await contender.tool[name].execute(args, { sessionID })
      assert.match(result, /Goal controls are unavailable/)
      assert.match(result, /\/objective status/)
    }
    assert.equal(await fs.readFile(paths.stateFilePath, "utf8"), stateBefore)
    assert.equal(await readMaybe(paths.ledgerFilePath), ledgerBefore)

    const otherResult = JSON.parse(
      await contender.tool.goal_set.execute(
        { objective: "independent session objective" },
        { sessionID: otherSessionID },
      ),
    )
    assert.equal(otherResult.ok, true)
    const otherState = JSON.parse(
      await fs.readFile(sessionPaths(stateFilePath, otherSessionID).stateFilePath, "utf8"),
    )
    assert.deepEqual(otherState.goals.map((goal) => goal.condition), ["independent session objective"])

    const activeDenial = { parts: [] }
    await contender["command.execute.before"](
      { command: "objective", sessionID, arguments: "status" },
      activeDenial,
    )
    const activeDenialParentID = await acceptCommandTurn(
      contender,
      sessionID,
      activeDenial,
    )

    await owner.dispose()
    owner = null
    await new Promise((resolve) => setTimeout(resolve, 300))

    const guardedRetry = JSON.parse(
      await contender.tool.goal_status.execute({}, { sessionID }),
    )
    assert.equal(guardedRetry.ok, false)
    assert.equal(guardedRetry.error, "session_owned_elsewhere")
    await assertNoLeaseOwner(`${paths.stateFilePath}.lock`)
    await finishControlTurn(
      contender,
      sessionID,
      activeDenialParentID,
      "Reported.",
      (message) => { hostMessages = [message] },
    )

    const ordinaryOutput = {
      message: { id: "passive-after-release", role: "user", sessionID },
      parts: [{ type: "text", text: "ordinary chat still must not seize the lease" }],
    }
    await contender["chat.message"](
      { sessionID, messageID: "passive-after-release", agent: "build" },
      ordinaryOutput,
    )
    await assertNoLeaseOwner(`${paths.stateFilePath}.lock`)

    const takeover = JSON.parse(await contender.tool.goal_status.execute({}, { sessionID }))
    assert.equal(takeover.ok, true)
    assert.match(takeover.message, /durable owner objective/)
    assert.match(takeover.message, /recovered after restart|paused|stopped/i)
    const stateAfterTakeover = await fs.readFile(paths.stateFilePath, "utf8")

    await contender.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "late-passive-denial-assistant",
            parentID: oldCommandParentID,
            role: "assistant",
            sessionID,
            tokens: { input: 9000, output: 9000, reasoning: 0 },
          },
        },
      },
    })
    assert.equal(await fs.readFile(paths.stateFilePath, "utf8"), stateAfterTakeover)
    const resumed = JSON.parse(await contender.tool.goal_resume.execute({}, { sessionID }))
    assert.equal(resumed.ok, true)
    const stateAfterResume = await fs.readFile(paths.stateFilePath, "utf8")
    assert.equal(testInternals.currentGoal(sessionID).stopped, false)

    await contender.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "late-passive-denial-error",
            parentID: oldCommandParentID,
            role: "assistant",
            sessionID,
            error: { name: "ProviderError", message: "late denial reply failed" },
          },
        },
      },
    })
    assert.equal(testInternals.currentGoal(sessionID).stopped, false)
    assert.equal(await fs.readFile(paths.stateFilePath, "utf8"), stateAfterResume)

    await idle(contender, sessionID)
    assert.equal(promptCalls.length, 1)
    assert.ok(messagesCalls.length >= 1)
    assert.equal(logs.length, 1)
  } finally {
    await contender?.dispose()
    await owner?.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("expired passive command guards require a fresh command boundary for takeover", async () => {
  for (const accepted of [false, true]) {
    const directory = await fs.mkdtemp(join(tmpdir(), "goal-plugin-passive-expired-command-"))
    const stateFilePath = join(directory, "state.json")
    const sessionID = `passive-expired-${accepted ? "active" : "pending"}`
    let owner
    let contender
    const originalNow = Date.now
    try {
      owner = await GoalPlugin(
        { client: hostClient(), directory },
        { stateFilePath, minDelayMs: 1 },
      )
      await setGoal(owner, sessionID, "durable objective for expired guard takeover")

      contender = await GoalPlugin(
        { client: hostClient(), directory },
        { stateFilePath, minDelayMs: 1 },
      )
      const denial = { parts: [] }
      await contender["command.execute.before"](
        { command: "goal", sessionID, arguments: "status" },
        denial,
      )
      if (accepted) await acceptCommandTurn(contender, sessionID, denial)

      await owner.dispose()
      owner = null
      const afterTtl = originalNow() + testInternals.commandTurnTtlMs + 1_000
      Date.now = () => afterTtl

      if (accepted) {
        await assert.rejects(
          contender["tool.execute.before"]({ sessionID, tool: "write" }),
          /no tool calls are allowed/i,
        )
        const guarded = JSON.parse(
          await contender.tool.goal_status.execute({}, { sessionID, agent: "build" }),
        )
        assert.equal(guarded.ok, false)
        assert.equal(guarded.error, "session_owned_elsewhere")

        const takeoverCommand = { parts: [] }
        const takeoverStarted = contender["command.execute.before"](
          { command: "goal", sessionID, arguments: "status" },
          takeoverCommand,
        )
        const oldTurnTool = contender["tool.execute.before"]({
          sessionID,
          tool: "write",
        })
        const [takeoverResult, oldTurnToolResult] = await Promise.allSettled([
          takeoverStarted,
          oldTurnTool,
        ])
        assert.equal(takeoverResult.status, "fulfilled")
        assert.equal(oldTurnToolResult.status, "rejected")
        assert.match(oldTurnToolResult.reason.message, /no tool calls are allowed/i)
        assert.match(takeoverCommand.parts[0].text, /durable objective for expired guard takeover/)
        assert.match(takeoverCommand.parts[0].text, /recovered after restart|paused|stopped/i)
      } else {
        const takeover = JSON.parse(
          await contender.tool.goal_status.execute({}, { sessionID, agent: "build" }),
        )
        assert.equal(takeover.ok, true, "pending guard expired")
        assert.match(takeover.message, /durable objective for expired guard takeover/)
        assert.match(takeover.message, /recovered after restart|paused|stopped/i)
      }
    } finally {
      Date.now = originalNow
      await contender?.dispose()
      await owner?.dispose()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
})

test("passive entry and disposal do not wait for a stalled host logger", { timeout: 2_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "goal-plugin-passive-logger-"))
  const stateFilePath = join(directory, "state.json")
  const sessionID = "passive-stalled-logger-session"
  let owner
  let contender
  let contenderSettled = false
  try {
    owner = await GoalPlugin(
      { client: hostClient(), directory },
      { stateFilePath, registerTools: false, minDelayMs: 1 },
    )
    await setGoal(owner, sessionID, "owner objective")

    contender = await GoalPlugin(
      {
        client: {
          app: { log: () => new Promise(() => {}) },
          session: hostClient().session,
        },
        directory,
      },
      { stateFilePath, registerTools: false, minDelayMs: 1 },
    )
    const hookResult = await Promise.race([
      contender["chat.params"]({ sessionID, agent: "build" }).then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ])
    contenderSettled = hookResult === "settled"
    assert.equal(hookResult, "settled")

    const disposeResult = await Promise.race([
      contender.dispose().then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ])
    assert.equal(disposeResult, "settled")
    contender = null
  } finally {
    if (contenderSettled) await contender?.dispose()
    await owner?.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("persistence recovery and disposal do not wait for a stalled host logger", { timeout: 5_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "goal-plugin-error-logger-"))
  const stateFilePath = join(directory, "state.json")
  const sessionID = "stalled-error-logger-session"
  const paths = sessionPaths(stateFilePath, sessionID)
  let releaseLogger
  const stalledLogger = new Promise((resolve) => { releaseLogger = resolve })
  let logCalls = 0
  let hooks
  let loadPromise
  let disposePromise
  try {
    await fs.mkdir(dirname(paths.stateFilePath), { recursive: true })
    await fs.writeFile(paths.stateFilePath, "{ malformed")
    const client = hostClient()
    client.app.log = () => {
      logCalls += 1
      return stalledLogger
    }
    hooks = await GoalPlugin(
      { client, directory },
      { stateFilePath, registerTools: false, minDelayMs: 1 },
    )

    loadPromise = hooks["chat.params"]({ sessionID, agent: "build" })
    assert.equal(
      await Promise.race([
        loadPromise.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 1_500)),
      ]),
      "settled",
    )
    assert.ok(logCalls >= 1)
    await fs.stat(`${paths.stateFilePath}.lock`)
    await fs.stat(`${paths.stateFilePath}.lock.claims-v2`)

    disposePromise = hooks.dispose()
    assert.equal(
      await Promise.race([
        disposePromise.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 1_500)),
      ]),
      "settled",
    )
    await assertNoLeaseOwner(`${paths.stateFilePath}.lock`)
    hooks = null
  } finally {
    releaseLogger?.()
    await Promise.allSettled([loadPromise, disposePromise].filter(Boolean))
    await hooks?.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a delayed idle lookup cannot repopulate command state after disposal", async () => {
  const sessionID = "disposed-idle-command-state"
  let resolveMessages
  let messagesStarted
  const started = new Promise((resolve) => { messagesStarted = resolve })
  const messages = new Promise((resolve) => { resolveMessages = resolve })
  const hooks = await GoalPlugin(
    {
      client: hostClient({
        messages: async () => {
          messagesStarted()
          return messages
        },
      }),
    },
    { persistState: false, minDelayMs: 1 },
  )
  try {
    await setGoal(hooks, sessionID, "dispose while command correlation is loading")
    const status = await setGoal(hooks, sessionID, "status")
    const parentID = await acceptCommandTurn(hooks, sessionID, status)
    const delayedIdle = idle(hooks, sessionID)
    await started

    await hooks.dispose()
    assert.equal(testInternals.runtimeSessionDiagnostics(sessionID).suppressedAssistantCount, 0)
    resolveMessages({
      data: [{
        info: {
          id: "late-command-assistant",
          parentID,
          role: "assistant",
          sessionID,
          tokens: { input: 1, output: 1, reasoning: 0 },
        },
        parts: [{ type: "text", text: "Reported." }],
      }],
    })
    await delayedIdle

    assert.equal(testInternals.runtimeSessionDiagnostics(sessionID).disposed, true)
    assert.equal(testInternals.runtimeSessionDiagnostics(sessionID).suppressedAssistantCount, 0)
  } finally {
    resolveMessages?.({ data: [] })
    await hooks.dispose()
  }
})

test("a delayed idle lookup cannot retire a newer command turn", async () => {
  const sessionID = "superseded-idle-command-turn"
  let resolveFirstMessages
  let signalFirstLookup
  let hostMessages = []
  let messageCalls = 0
  const firstLookupStarted = new Promise((resolve) => { signalFirstLookup = resolve })
  const firstMessages = new Promise((resolve) => { resolveFirstMessages = resolve })
  const hooks = await GoalPlugin(
    {
      client: hostClient({
        messages: async () => {
          messageCalls += 1
          if (messageCalls === 1) {
            signalFirstLookup()
            return firstMessages
          }
          return { data: hostMessages }
        },
      }),
    },
    { persistState: false, minDelayMs: 1 },
  )
  try {
    await setGoal(hooks, sessionID, "keep the newest command guard")

    const firstStatus = await setGoal(hooks, sessionID, "status")
    const firstParentID = await acceptCommandTurn(hooks, sessionID, firstStatus)
    const delayedIdle = idle(hooks, sessionID)
    await firstLookupStarted

    const secondStatus = await setGoal(hooks, sessionID, "status")
    const secondParentID = await acceptCommandTurn(hooks, sessionID, secondStatus)
    resolveFirstMessages({
      data: [{
        info: {
          id: "first-command-assistant",
          parentID: firstParentID,
          role: "assistant",
          sessionID,
          tokens: { input: 1, output: 1, reasoning: 0 },
        },
        parts: [{ type: "text", text: "Reported first status." }],
      }],
    })
    await delayedIdle

    await assert.rejects(
      hooks["tool.execute.before"]({ sessionID, tool: "write" }),
      /no tool calls are allowed/i,
    )

    hostMessages = [{
      info: {
        id: "second-command-assistant",
        parentID: secondParentID,
        role: "assistant",
        sessionID,
        tokens: { input: 1, output: 1, reasoning: 0 },
      },
      parts: [{ type: "text", text: "Reported second status." }],
    }]
    await idle(hooks, sessionID)
    await assert.doesNotReject(() =>
      hooks["tool.execute.before"]({ sessionID, tool: "read" }),
    )
  } finally {
    resolveFirstMessages?.({ data: [] })
    await hooks.dispose()
  }
})

test("passive Plan context survives explicit takeover and prevents auto-continue", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "goal-plugin-passive-plan-"))
  const stateFilePath = join(directory, "state.json")
  const sessionID = "passive-plan-session"
  const promptCalls = []
  let owner
  let contender
  try {
    owner = await GoalPlugin(
      { client: hostClient(), directory },
      { stateFilePath, minDelayMs: 1, noToolCallTurnsBeforePause: 10 },
    )
    await setGoal(owner, sessionID, "never continue while Plan is active")

    contender = await GoalPlugin(
      {
        client: hostClient({
          promptAsync: async (input) => {
            promptCalls.push(input)
            return {}
          },
        }),
        directory,
      },
      { stateFilePath, minDelayMs: 1, noToolCallTurnsBeforePause: 10 },
    )
    await contender["chat.params"]({
      sessionID,
      agent: "Plan",
      model: { providerID: "test", modelID: "plan" },
    })

    await owner.dispose()
    owner = null
    await new Promise((resolve) => setTimeout(resolve, 300))

    const resumed = JSON.parse(
      await contender.tool.goal_resume.execute({}, { sessionID, agent: "Plan" }),
    )
    assert.equal(resumed.ok, true)
    await idle(contender, sessionID)

    assert.equal(promptCalls.length, 0)
    const status = JSON.parse(
      await contender.tool.goal_status.execute({}, { sessionID, agent: "Plan" }),
    )
    assert.equal(status.ok, true)
    assert.match(status.message, /Plan|plan agent active/i)
  } finally {
    await contender?.dispose()
    await owner?.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("partial tool context preserves the model and variant observed from the host", async () => {
  const sessionID = "partial-tool-context-session"
  const hooks = await GoalPlugin(
    { client: hostClient(), directory: "/workspace/partial-tool-context" },
    { persistState: false, minDelayMs: 1 },
  )
  try {
    await hooks["chat.params"]({
      sessionID,
      agent: "build",
      model: { providerID: "openrouter", modelID: "model-a" },
      message: { model: { variant: "high" } },
    })
    const result = JSON.parse(
      await hooks.tool.goal_set.execute(
        { objective: "preserve the initiating execution context" },
        { sessionID, agent: "goal-worker" },
      ),
    )
    assert.equal(result.ok, true)
    assert.deepEqual(testInternals.currentGoal(sessionID).executionContext, {
      agent: "goal-worker",
      model: { providerID: "openrouter", modelID: "model-a" },
      variant: "high",
    })
  } finally {
    await hooks.dispose()
  }
})

test("authoritative model changes clear an omitted variant before partial tool context merges", async () => {
  const sessionID = "authoritative-model-change-session"
  const hooks = await GoalPlugin(
    { client: hostClient(), directory: "/workspace/authoritative-model-change" },
    { persistState: false, minDelayMs: 1 },
  )
  try {
    await hooks["chat.params"]({
      sessionID,
      agent: "build",
      model: { providerID: "openrouter", modelID: "model-a" },
      message: { model: { variant: "high" } },
    })
    await hooks["chat.message"](
      {
        sessionID,
        messageID: "model-b-user-message",
        agent: "build",
        model: { providerID: "openrouter", modelID: "model-b" },
      },
      {
        message: { id: "model-b-user-message", role: "user", sessionID },
        parts: [{ type: "text", text: "switch models" }],
      },
    )

    const result = JSON.parse(
      await hooks.tool.goal_set.execute(
        { objective: "use the current model without a stale variant" },
        { sessionID, agent: "goal-worker" },
      ),
    )
    assert.equal(result.ok, true)
    assert.deepEqual(testInternals.currentGoal(sessionID).executionContext, {
      agent: "goal-worker",
      model: { providerID: "openrouter", modelID: "model-b" },
    })
  } finally {
    await hooks.dispose()
  }
})

test("passive tool recovery stays actionable when slash-command registration is disabled", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "goal-plugin-passive-tools-only-"))
  const stateFilePath = join(directory, "state.json")
  const sessionID = "passive-tools-only-session"
  let owner
  let contender
  try {
    owner = await GoalPlugin(
      { client: hostClient(), directory },
      { stateFilePath, minDelayMs: 1 },
    )
    await setGoal(owner, sessionID, "owner objective")

    contender = await GoalPlugin(
      { client: hostClient(), directory },
      { stateFilePath, registerCommand: false, minDelayMs: 1 },
    )
    assert.equal(contender["command.execute.before"], undefined)
    const result = JSON.parse(
      await contender.tool.goal_status.execute({}, { sessionID, agent: "build" }),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error, "session_owned_elsewhere")
    assert.match(result.message, /goal_status/)
    assert.doesNotMatch(result.message, /\/goal status/)
  } finally {
    await contender?.dispose()
    await owner?.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  }
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
    await fs.readFile(
      sessionPaths(join(firstDirectory, ".opencode", "goals", "state.json"), "session-persist-one").stateFilePath,
      "utf8",
    ),
  )
  const secondState = JSON.parse(
    await fs.readFile(
      sessionPaths(join(secondDirectory, ".opencode", "goals", "state.json"), "session-persist-two").stateFilePath,
      "utf8",
    ),
  )
  assert.deepEqual(firstState.goals.map((goal) => goal.sessionID), ["session-persist-one"])
  assert.deepEqual(secondState.goals.map((goal) => goal.sessionID), ["session-persist-two"])

  const firstLedger = await fs.readFile(
    sessionPaths(join(firstDirectory, ".opencode", "goals", "state.json"), "session-persist-one").ledgerFilePath,
    "utf8",
  )
  const secondLedger = await fs.readFile(
    sessionPaths(join(secondDirectory, ".opencode", "goals", "state.json"), "session-persist-two").ledgerFilePath,
    "utf8",
  )
  assert.match(firstLedger, /session-persist-one/)
  assert.doesNotMatch(firstLedger, /session-persist-two/)
  assert.match(secondLedger, /session-persist-two/)
  assert.doesNotMatch(secondLedger, /session-persist-one/)
})
