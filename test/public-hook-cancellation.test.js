import assert from "node:assert/strict"
import test from "node:test"
import { GoalPlugin } from "../src/goal-plugin.js"

function deferred() {
  let resolve
  const promise = new Promise((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function assistantMessage(sessionID, id = `assistant-${sessionID}`) {
  return {
    info: {
      id,
      role: "assistant",
      sessionID,
      tokens: { input: 10, output: 100, reasoning: 0 },
    },
    parts: [{ type: "text", text: "Work remains." }],
  }
}

async function plugin({ messages, promptAsync, minDelayMs = 1 }) {
  return GoalPlugin(
    {
      directory: "/workspace/public-hook-cancellation",
      client: {
        app: { log: async () => {} },
        session: { messages, promptAsync },
      },
    },
    {
      persistState: false,
      registerTools: false,
      minDelayMs,
      noToolCallTurnsBeforePause: 10,
    },
  )
}

async function goalCommand(hooks, sessionID, arguments_) {
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: arguments_ },
    { parts: [] },
  )
}

function idle(hooks, sessionID, eventID) {
  return hooks.event({
    event: {
      id: eventID,
      type: "session.status",
      properties: { id: eventID, sessionID, status: { type: "idle" } },
    },
  })
}

function abort(hooks, sessionID) {
  return hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID,
        error: { name: "MessageAbortedError", message: "The operation was aborted" },
      },
    },
  })
}

test("duplicate idle event IDs coalesce into exactly one continuation", async () => {
  const sessionID = "duplicate-idle"
  const messagesStarted = deferred()
  const messagesResult = deferred()
  const promptCalls = []
  let messageCalls = 0
  const hooks = await plugin({
    messages: async () => {
      messageCalls += 1
      messagesStarted.resolve()
      return messagesResult.promise
    },
    promptAsync: async (input) => {
      promptCalls.push(input)
      return {}
    },
  })
  await goalCommand(hooks, sessionID, "coalesce duplicate host events")

  const first = idle(hooks, sessionID, "idle-event-1")
  await messagesStarted.promise
  const duplicate = idle(hooks, sessionID, "idle-event-1")
  messagesResult.resolve({ data: [assistantMessage(sessionID)] })
  await Promise.all([first, duplicate])

  assert.equal(messageCalls, 1, "a duplicate event must share or skip the in-flight read")
  assert.equal(promptCalls.length, 1, "a duplicate event must produce one continuation")
})

test("abort while session.messages is pending prevents continuation", async () => {
  const sessionID = "abort-pending-messages"
  const messagesStarted = deferred()
  const messagesResult = deferred()
  const promptCalls = []
  const hooks = await plugin({
    messages: async () => {
      messagesStarted.resolve()
      return messagesResult.promise
    },
    promptAsync: async (input) => {
      promptCalls.push(input)
      return {}
    },
  })
  await goalCommand(hooks, sessionID, "honor abort during host reads")

  const pendingIdle = idle(hooks, sessionID, "abort-idle")
  await messagesStarted.promise
  await abort(hooks, sessionID)
  messagesResult.resolve({ data: [assistantMessage(sessionID)] })
  await pendingIdle

  assert.equal(promptCalls.length, 0)
})

test("dispose while session.messages is pending prevents continuation", async () => {
  const sessionID = "dispose-pending-messages"
  const messagesStarted = deferred()
  const messagesResult = deferred()
  const promptCalls = []
  const hooks = await plugin({
    messages: async () => {
      messagesStarted.resolve()
      return messagesResult.promise
    },
    promptAsync: async (input) => {
      promptCalls.push(input)
      return {}
    },
  })
  await goalCommand(hooks, sessionID, "honor disposal during host reads")

  const pendingIdle = idle(hooks, sessionID, "dispose-idle")
  await messagesStarted.promise
  await hooks.dispose()
  messagesResult.resolve({ data: [assistantMessage(sessionID)] })
  await pendingIdle

  assert.equal(promptCalls.length, 0)
})

test("resume invalidates an old pending messages request and permits one fresh continuation", async () => {
  const sessionID = "resume-pending-messages"
  const oldMessagesStarted = deferred()
  const oldMessagesResult = deferred()
  const promptCalls = []
  let messageCalls = 0
  const hooks = await plugin({
    messages: async () => {
      messageCalls += 1
      if (messageCalls === 1) {
        oldMessagesStarted.resolve()
        return oldMessagesResult.promise
      }
      return { data: [assistantMessage(sessionID, `assistant-${messageCalls}`)] }
    },
    promptAsync: async (input) => {
      promptCalls.push(input)
      return {}
    },
  })
  await goalCommand(hooks, sessionID, "resume into a new lifecycle epoch")

  const oldIdle = idle(hooks, sessionID, "old-epoch-idle")
  await oldMessagesStarted.promise
  await goalCommand(hooks, sessionID, "pause")
  await goalCommand(hooks, sessionID, "resume")
  oldMessagesResult.resolve({ data: [assistantMessage(sessionID, "old-assistant")] })
  await oldIdle

  assert.equal(promptCalls.length, 0, "the pre-resume request must not continue the new epoch")
  await idle(hooks, sessionID, "new-epoch-idle")
  assert.equal(promptCalls.length, 1, "the resumed epoch must accept one fresh continuation")
})

test("abort during cooldown prevents the delayed continuation", async () => {
  const sessionID = "abort-during-cooldown"
  const promptCalls = []
  const cooldownMs = 80
  const hooks = await plugin({
    minDelayMs: cooldownMs,
    messages: async () => ({ data: [assistantMessage(sessionID)] }),
    promptAsync: async (input) => {
      promptCalls.push(input)
      return {}
    },
  })
  await goalCommand(hooks, sessionID, "honor abort during cooldown")
  await idle(hooks, sessionID, "initial-idle")
  assert.equal(promptCalls.length, 1)

  const delayedIdle = idle(hooks, sessionID, "cooldown-idle")
  await new Promise((resolve) => setTimeout(resolve, 10))
  await abort(hooks, sessionID)
  await delayedIdle

  assert.equal(promptCalls.length, 1, "abort must cancel the continuation waiting in cooldown")
})
