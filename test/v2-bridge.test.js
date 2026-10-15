import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { z } from "zod"
import goalPlugin, { GoalPlugin, testInternals } from "../src/goal-plugin.js"
import { applyNativeGoalConfig } from "../src/native-agent-config.js"
import {
  GOAL_COMMAND_DESCRIPTION,
  createHostState,
  createV2Client,
  createV2Setup,
  eventBelongsToLocation,
  normalizeMessageList,
  toV1Event,
  translateV1Agent,
  v1PermissionsToRules,
  v1ToolsToRules,
} from "../src/v2-bridge.js"

/* ------------------------------------------------------------------ *
 * Entry point: one default export serves both OpenCode lines
 * ------------------------------------------------------------------ */

test("default export carries both the V1 server factory and the V2 setup", () => {
  assert.equal(goalPlugin.id, "opencode-goal-plugin")
  assert.equal(typeof goalPlugin.server, "function")
  assert.equal(typeof goalPlugin.setup, "function")
  // V1 reads `server`, V2 reads `setup`; neither may be a getter the loader
  // would trip over, and both must target the same plugin id.
  assert.equal(goalPlugin.server, GoalPlugin)
})

/* ------------------------------------------------------------------ *
 * Event normalization (V2 event stream -> V1 event hook contract)
 * ------------------------------------------------------------------ */

test("execution lifecycle maps onto the V1 idle/error/status driver events", () => {
  const host = createHostState()

  const started = toV1Event(
    { id: "e1", type: "session.execution.started", data: { sessionID: "s1" } },
    host,
  )
  assert.equal(started.type, "session.status")
  assert.deepEqual(started.properties.status, { type: "busy" })
  assert.deepEqual(host.statuses.get("s1"), { type: "busy" })

  const idle = toV1Event(
    { id: "e2", type: "session.execution.succeeded", data: { sessionID: "s1" } },
    host,
  )
  assert.equal(idle.type, "session.idle")
  assert.equal(idle.properties.sessionID, "s1")
  // Unique id: the plugin dedups idles by event id, and a later, genuinely
  // different idle must not be swallowed by an earlier one.
  assert.notEqual(idle.id, "e2")
  assert.deepEqual(host.statuses.get("s1"), { type: "idle" })

  const failed = toV1Event(
    {
      id: "e3",
      type: "session.execution.failed",
      data: { sessionID: "s1", error: { type: "ProviderError", message: "boom" } },
    },
    host,
  )
  assert.equal(failed.type, "session.error")
  assert.deepEqual(failed.properties.error, { name: "ProviderError", message: "boom" })

  const interrupted = toV1Event(
    { id: "e4", type: "session.execution.interrupted", data: { sessionID: "s1", reason: "user" } },
    host,
  )
  assert.equal(interrupted.type, "session.error")
  assert.equal(interrupted.properties.error.name, "MessageAbortedError")
})

test("compaction, permission, and execution-context events keep their V1 shapes", () => {
  const host = createHostState()

  const compaction = toV1Event(
    { id: "cmp-1", type: "session.compaction.ended", data: { sessionID: "s1" } },
    host,
  )
  assert.equal(compaction.type, "session.compacted")
  assert.equal(compaction.id, "cmp-1")

  const permission = toV1Event(
    { id: "p1", type: "permission.replied", data: { sessionID: "s1", requestID: "r", reply: "reject" } },
    host,
  )
  assert.equal(permission.type, "permission.replied")
  assert.equal(permission.properties.reply, "reject")

  const agent = toV1Event(
    { id: "a1", type: "session.agent.selected", data: { sessionID: "s1", agent: "plan" } },
    host,
  )
  assert.equal(agent.type, "session.updated")
  assert.equal(agent.properties.info.agent, "plan")

  const model = toV1Event(
    {
      id: "m1",
      type: "session.model.selected",
      data: { sessionID: "s1", model: { providerID: "anthropic", id: "claude" } },
    },
    host,
  )
  assert.equal(model.type, "session.updated")
  assert.deepEqual(model.properties.info.model, { providerID: "anthropic", id: "claude" })

  assert.equal(toV1Event({ id: "x", type: "models-dev.refreshed", data: {} }, host), null)
  assert.equal(toV1Event({ id: "y", type: "plugin.updated", data: {} }, host), null)
  assert.equal(toV1Event(undefined, host), null)
})

test("assistant step events carry usage, derived parent, and goal-relevant agents", () => {
  const host = createHostState()
  host.lastPromptMessageIDs.set("s1", "user-1")

  toV1Event(
    { id: "st1", type: "session.step.started", data: { sessionID: "s1", assistantMessageID: "as-1", agent: "build" } },
    host,
  )
  const ended = toV1Event(
    {
      id: "st2",
      type: "session.step.ended",
      data: {
        sessionID: "s1",
        assistantMessageID: "as-1",
        cost: 0.01,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      },
    },
    host,
  )
  assert.equal(ended.type, "message.updated")
  assert.equal(ended.properties.info.role, "assistant")
  assert.equal(ended.properties.info.parentID, "user-1")
  assert.equal(ended.properties.info.agent, "build")
  assert.equal(ended.properties.info.cost, 0.01)
  assert.equal(ended.properties.info.tokens.output, 5)

  // A retryable step failure must not pause the goal: terminal provider
  // failures arrive as session.execution.failed instead.
  toV1Event(
    { id: "st3", type: "session.step.started", data: { sessionID: "s1", assistantMessageID: "as-2", agent: "build" } },
    host,
  )
  const failed = toV1Event(
    {
      id: "st4",
      type: "session.step.failed",
      data: { sessionID: "s1", assistantMessageID: "as-2", error: { type: "X", message: "retry me" } },
    },
    host,
  )
  assert.equal(failed.type, "message.updated")
  assert.equal(failed.properties.info.error, undefined)

  // Title and compaction model runs are host bookkeeping: their tokens never
  // reach the goal budget and their failures never pause a goal.
  toV1Event(
    { id: "st5", type: "session.step.started", data: { sessionID: "s1", assistantMessageID: "as-3", agent: "title" } },
    host,
  )
  assert.equal(
    toV1Event(
      { id: "st6", type: "session.step.ended", data: { sessionID: "s1", assistantMessageID: "as-3", tokens: { output: 9 } } },
      host,
    ),
    null,
  )
  toV1Event(
    { id: "st7", type: "session.step.started", data: { sessionID: "s1", assistantMessageID: "as-4", agent: "compaction" } },
    host,
  )
  assert.equal(
    toV1Event(
      { id: "st8", type: "session.step.failed", data: { sessionID: "s1", assistantMessageID: "as-4" } },
      host,
    ),
    null,
  )
})

test("events from another location are dropped before they reach the goal core", () => {
  const host = createHostState()
  const own = "C:\\proj\\app"
  const foreign = { id: "e1", type: "session.execution.succeeded", data: { sessionID: "s1" }, location: { directory: "C:\\other\\app" } }
  const local = { ...foreign, location: { directory: own } }
  const unscoped = { id: "e2", type: "session.execution.succeeded", data: { sessionID: "s1" } }

  assert.equal(eventBelongsToLocation(foreign, own), false)
  assert.equal(eventBelongsToLocation(local, own), true)
  // Trailing separators and case must not matter on Windows.
  assert.equal(eventBelongsToLocation({ ...local, location: { directory: "C:\\PROJ\\APP\\" } }, own), process.platform === "win32")
  // A host that reports no location behaves like V1 (project-scoped) delivery.
  assert.equal(eventBelongsToLocation(unscoped, own), true)
  assert.equal(eventBelongsToLocation(foreign, ""), true)
  // `toV1Event` itself is location-agnostic; the subscriber applies the
  // filter (asserted directly here) before anything reaches the goal core.
  assert.notEqual(toV1Event(foreign, host), null)
})

test("directory isolation normalizes long separator runs without backtracking", () => {
  const source = new URL("../src/v2-bridge.js", import.meta.url).href
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict"
    import { eventBelongsToLocation } from ${JSON.stringify(source)}
    const directory = "/".repeat(200000) + "project"
    assert.equal(eventBelongsToLocation({ location: { directory: directory + "/\\\\/" } }, directory), true)
    assert.equal(eventBelongsToLocation({ location: { directory } }, directory + "-other"), false)
  `], { timeout: 5000, encoding: "utf8" })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
})

/* ------------------------------------------------------------------ *
 * Message normalization (V2 transcript -> V1 message contract)
 * ------------------------------------------------------------------ */

const textOf = (parts) =>
  (parts || [])
    .filter((part) => part && part.type === "text" && !part.ignored)
    .map((part) => part.text || "")
    .join("\n")
    .trim()

test("transcript normalization rebuilds parts, markers, and assistant parents", () => {
  const messages = [
    { id: "u1", type: "user", text: "ship it", files: [{ uri: "file:///a.txt", name: "a.txt" }] },
    { id: "a1", type: "assistant", agent: "build", cost: 0.5, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "working" },
      { type: "tool", id: "t1", name: "bash" },
    ] },
    { id: "u2", type: "user", text: "continue", metadata: { "opencode-goal-plugin": { kind: "continuation", id: "tok" } } },
    { id: "a2", type: "assistant", content: [{ type: "text", text: "done" }] },
    { id: "c1", type: "compaction", summary: "…" },
  ]

  const normalized = normalizeMessageList(messages, "s1")
  assert.equal(normalized.length, 5)

  const [user, assistant, continuation, second, compaction] = normalized
  assert.equal(user.role, "user")
  assert.deepEqual(
    user.parts.map((part) => part.type),
    ["text", "file"],
  )
  assert.equal(user.parts[0].messageID, "u1")
  assert.equal(user.parts[0].sessionID, "s1")

  // V2 has no parent link: it is derived from the user message that opened
  // the turn, which is what control-command correlation compares against.
  assert.equal(assistant.parentID, "u1")
  assert.equal(assistant.cost, 0.5)
  assert.equal(assistant.tokens.output, 2)
  assert.equal(
    textOf(assistant.parts),
    "working",
    "reasoning must never be readable as the assistant's answer",
  )
  assert.ok(testInternals.messageHasToolCall(assistant))

  // Plugin-owned prompts round-trip their marker through message metadata.
  assert.equal(continuation.parts[0].synthetic, true)
  assert.deepEqual(continuation.parts[0].metadata["opencode-goal-plugin"], {
    kind: "continuation",
    id: "tok",
  })
  assert.equal(second.parentID, "u2")

  // Compaction summaries are their own role: they are never an assistant turn.
  assert.equal(compaction.role, "compaction")
  assert.equal(testInternals.findLatestAssistantMessage(normalized).id, "a2")
})

/* ------------------------------------------------------------------ *
 * Session client (flat inputs, V1 result shapes)
 * ------------------------------------------------------------------ */

function fakeClientHost(overrides = {}) {
  const calls = []
  const record = (name) => async (input) => {
    calls.push({ name, input })
    return overrides[name] ? await overrides[name](input) : { id: "s1" }
  }
  const ctx = {
    location: { directory: "/project" },
    session: {
      context: record("context"),
      prompt: record("prompt"),
      get: record("get"),
      create: record("create"),
      update: record("update"),
      interrupt: record("interrupt"),
      switchAgent: record("switchAgent"),
    },
  }
  return { ctx, calls }
}

test("session client speaks flat inputs and returns V1 result shapes", async () => {
  const { ctx, calls } = fakeClientHost({
    context: async () => [
      { id: "u1", type: "user", text: "one" },
      { id: "a1", type: "assistant", content: [{ type: "text", text: "two" }] },
      { id: "u2", type: "user", text: "three" },
    ],
  })
  const client = createV2Client(ctx, createHostState()).session

  const messages = await client.messages({ sessionID: "s1", limit: 2 })
  assert.deepEqual(calls[0], { name: "context", input: { sessionID: "s1" } })
  assert.deepEqual(messages.map((m) => m.id), ["a1", "u2"], "limit slices the newest messages")
  assert.equal(messages[0].parentID, "u1")

  // Continuation prompts: V1 parts become one flat V2 text prompt carrying
  // the correlation marker, and a host failure resolves to `{error}` so the
  // goal loop can count a prompt failure instead of crashing.
  const prompted = await client.promptAsync({
    sessionID: "s1",
    parts: [{ type: "text", text: "keep going", metadata: { "opencode-goal-plugin": { kind: "continuation", id: "tok" } }, synthetic: true }],
  })
  assert.equal(prompted.error, undefined)
  assert.deepEqual(calls[1].input, {
    sessionID: "s1",
    text: "keep going",
    metadata: { "opencode-goal-plugin": { kind: "continuation", id: "tok" } },
  })

  ctx.session.prompt = async () => {
    throw new Error("provider offline")
  }
  const failed = await client.promptAsync({ sessionID: "s1", parts: [{ type: "text", text: "x" }] })
  assert.equal(failed.error.name, "Error")
  assert.match(failed.error.message, /provider offline/)

  await client.update({ sessionID: "s1", title: "status" })
  assert.deepEqual(calls.at(-1).input, { sessionID: "s1", title: "status" })

  await client.abort({ sessionID: "s1" })
  assert.deepEqual(calls.at(-1).input, { sessionID: "s1", resume: false })
})

test("createChild records the parent link in metadata and echoes it back", async () => {
  const { ctx, calls } = fakeClientHost({ create: async (input) => ({ id: "child-1", ...input }) })
  const client = createV2Client(ctx, createHostState()).session

  const created = await client.create({ parentID: "parent-1", title: "goal completion audit" })
  assert.equal(calls[0].input.metadata["opencode-goal-plugin"].parentSessionID, "parent-1")
  assert.equal(created.parentID, "parent-1")
  assert.equal(created.id, "child-1")

  const plain = await client.create({ title: "no parent" })
  assert.equal(plain.parentID, undefined)
})

test("children and status expose the shapes the active-children gate reads", async () => {
  const host = createHostState()
  host.children.set("parent-1", new Set(["child-1"]))
  host.statuses.set("child-1", { type: "idle" })
  const client = createV2Client(fakeClientHost().ctx, host).session

  // `childStatusIsActive` requires `{id}` records and a `{type}` status map.
  assert.deepEqual(await client.children({ sessionID: "parent-1" }), [{ id: "child-1" }])
  assert.deepEqual(await client.status(), { "child-1": { type: "idle" } })
  assert.deepEqual(await client.children({ sessionID: "unknown" }), [])
})

/* ------------------------------------------------------------------ *
 * V1 config translation
 * ------------------------------------------------------------------ */

test("V1 agent permission and tool maps become ordered V2 permission rules", () => {
  const rules = v1PermissionsToRules({
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    edit: "deny",
    bash: "deny",
  })
  // Last matching rule wins in V2, so the wildcard catch-all must come first.
  assert.deepEqual(rules[0], { action: "*", resource: "*", effect: "deny" })
  const actions = rules.map((rule) => rule.action)
  assert.ok(actions.includes("read"))
  assert.ok(actions.includes("shell"), "renamed V2 action is emitted alongside its V1 spelling")
  assert.deepEqual(v1PermissionsToRules(undefined), [])

  const toolRules = v1ToolsToRules({ bash: false, write: false, read: true, goal_set: false })
  assert.deepEqual(
    toolRules.map((rule) => [rule.action, rule.effect]),
    [
      ["bash", "deny"],
      ["shell", "deny"],
      ["write", "deny"],
      ["edit", "deny"],
      ["goal_set", "deny"],
    ],
  )

  const agent = translateV1Agent("goal-verify", {
    description: "Verify a claim",
    mode: "subagent",
    hidden: true,
    prompt: "Verify independently.",
    permission: { "*": "deny", read: "allow" },
    tools: { bash: false },
  })
  assert.equal(agent.id, "goal-verify")
  assert.equal(agent.name, "goal-verify")
  assert.equal(agent.mode, "subagent")
  assert.equal(agent.hidden, true)
  // V2 renamed the V1 `prompt` field to `system`.
  assert.equal(agent.system, "Verify independently.")
  assert.ok(agent.permissions.some((rule) => rule.action === "bash" && rule.effect === "deny"))
})

/* ------------------------------------------------------------------ *
 * setup(ctx): registration surface
 * ------------------------------------------------------------------ */

function createFakeCtx({ events = [], commands = [], pluginOptions = {} } = {}) {
  const registered = { sessionHooks: {}, toolHooks: {}, tools: [], agents: [], commands: [] }
  const calls = { prompt: [], context: [], interrupt: [], switchedAgents: [] }
  const eventQueue = [...events]
  let wake = null
  const toolEditor = () => {
    const added = new Map()
    return {
      added,
      add: (definition) => added.set(definition.name, definition),
      update: () => {},
      remove: () => {},
      namespace: () => {},
    }
  }
  const registrations = []
  const track = (name) => ({
    dispose: async () => {
      registrations.push(name)
    },
  })

  const ctx = {
    options: pluginOptions,
    location: { directory: "C:\\proj" },
    session: {
      hook: async (name, callback) => {
        (registered.sessionHooks[name] ||= []).push(callback)
        return track(`session:${name}`)
      },
      context: async (input) => {
        calls.context.push(input)
        return []
      },
      prompt: async (input) => {
        calls.prompt.push(input)
        return { id: "inbox-1" }
      },
      get: async () => ({ id: "s1" }),
      create: async (input) => ({ id: "child", ...input }),
      update: async () => {},
      interrupt: async () => {},
      switchAgent: async (input) => calls.switchedAgents.push(input),
    },
    tool: {
      hook: async (name, callback) => {
        (registered.toolHooks[name] ||= []).push(callback)
        return track(`tool:${name}`)
      },
      transform: async (callback) => {
        const editor = toolEditor()
        callback(editor)
        registered.tools.push(editor)
        return track("tool.transform")
      },
    },
    agent: {
      transform: async (callback) => {
        const store = new Map()
        const editor = {
          store,
          get: (id) => store.get(id),
          update: (id, mutate) => {
            const current = store.get(id) || { id, name: id, permissions: [] }
            store.set(id, current)
            mutate(current)
          },
          list: () => [...store.values()],
          remove: (id) => store.delete(id),
          default: () => {},
        }
        callback(editor)
        registered.agents.push(editor)
        return track("agent.transform")
      },
      get: async () => undefined,
    },
    command: {
      transform: async (callback) => {
        const store = new Map()
        const editor = { store, add: (definition) => store.set(definition.name, definition) }
        callback(editor)
        registered.commands.push(editor)
        return track("command.transform")
      },
      list: async () => ({ data: commands }),
    },
    event: {
      subscribe: async function* ({ signal } = {}) {
        let index = 0
        for (;;) {
          while (index < eventQueue.length) yield eventQueue[index++]
          if (signal?.aborted) return
          await new Promise((resolve) => {
            wake = resolve
            signal?.addEventListener("abort", resolve, { once: true })
          })
          if (signal?.aborted) return
        }
      },
    },
    /** Deliver an event after setup, as the live stream would. */
    __emit(event) {
      eventQueue.push(event)
      const resolve = wake
      wake = null
      resolve?.()
    },
  }
  return { ctx, registered, calls, registrations }
}

const settle = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

test("failed required agent switches never submit a prompt", async () => {
  const { ctx, calls } = fakeClientHost()
  ctx.session.switchAgent = async () => { throw new Error("agent unavailable") }
  const client = createV2Client(ctx).session
  for (const operation of ["prompt", "promptAsync"]) {
    const result = await client[operation]({ sessionID: "child", agent: "goal-verify", parts: [{ type: "text", text: "audit" }] })
    assert.match(result.error.message, /agent unavailable/)
  }
  assert.equal(calls.length, 0)
})

test("V2 verifier ownership tolerates host-added deny rules but nothing that widens access", async () => {
  const { ctx, calls } = fakeClientHost()
  const owned = translateV1Agent("goal-verify", applyNativeGoalConfig({}).agent["goal-verify"])
  let actual
  ctx.agent = { get: async () => actual }
  const client = createV2Client(ctx, createHostState(), { completionAudit: true }).session
  const input = { sessionID: "child", agent: "goal-verify", parts: [{ type: "text", text: "audit" }] }
  const hostDeny = { action: "browser", resource: "*", effect: "deny" }
  const [first, ...rest] = owned.permissions

  // OpenCode 2.0.26 appends a `browser` deny to every agent.
  for (const permissions of [[...owned.permissions, hostDeny], [first, hostDeny, ...rest]]) {
    actual = { ...owned, permissions }
    assert.equal((await client.prompt(input)).error, undefined, JSON.stringify(permissions.at(-1)))
  }
  const accepted = calls.filter(call => call.name === "prompt").length
  assert.equal(accepted, 2)

  for (const permissions of [
    [...owned.permissions, { action: "browser", resource: "*", effect: "allow" }],
    [...owned.permissions, { action: "edit", resource: "*", effect: "ask" }],
    owned.permissions.slice(1),
    [...rest, first],
  ]) {
    actual = { ...owned, permissions }
    assert.match((await client.prompt(input)).error.message, /ownership or permissions/)
  }
  assert.equal(calls.filter(call => call.name === "prompt").length, accepted)
})

test("V2 verifier ownership is checked before each prompt, including permission changes", async () => {
  const { ctx, calls } = fakeClientHost()
  const native = applyNativeGoalConfig({}).agent["goal-verify"]
  const owned = translateV1Agent("goal-verify", native)
  let actual
  ctx.agent = { get: async () => actual }
  const client = createV2Client(ctx, createHostState(), { completionAudit: true }).session
  const input = { sessionID: "child", agent: "goal-verify", parts: [{ type: "text", text: "audit" }] }
  for (const foreign of [undefined, { ...owned, system: "foreign prompt" }, { ...owned, permissions: [...owned.permissions, { action: "shell", resource: "*", effect: "allow" }] }]) {
    actual = foreign
    assert.match((await client.prompt(input)).error.message, /ownership or permissions/)
    assert.equal(calls.length, 0)
  }
  actual = owned
  assert.equal((await client.prompt(input)).error, undefined)
  assert.equal(calls.filter(call => call.name === "prompt").length, 1)
  actual = { ...owned, system: "replaced after first audit" }
  assert.ok((await client.prompt(input)).error)
  assert.equal(calls.filter(call => call.name === "prompt").length, 1)
})

test("synchronous V2 audit waits for execution and maps child deletion", async () => {
  const { ctx, calls } = fakeClientHost()
  let finished = false
  ctx.session.wait = async input => { assert.equal(input.sessionID, "child"); finished = true }
  ctx.session.context = async () => {
    assert.equal(finished, true)
    return [{ id: "a1", type: "assistant", content: [{ type: "text", text: "[audit:approved]" }] }]
  }
  ctx.session.remove = async input => calls.push({ name: "remove", input })
  const client = createV2Client(ctx).session
  const result = await client.prompt({ sessionID: "child", parts: [{ type: "text", text: "audit" }] })
  assert.equal(result.parts[0].text, "[audit:approved]")
  await client.delete({ sessionID: "child" })
  assert.deepEqual(calls.at(-1), { name: "remove", input: { sessionID: "child" } })
})

test("a rejected verifier config revokes previously confirmed completion readiness", async () => {
  let audits = 0
  const hooks = await GoalPlugin({ client: { session: { create: async () => { audits++; return { id: "child", parentID: "parent" } }, prompt: async () => ({ parts: [{ type: "text", text: "[audit:approved]" }] }) } } }, { persistState: false, completionAudit: true, auditMessages: false, lifecycleMessages: false })
  try {
    await hooks.config({})
    await assert.rejects(hooks.config({ agent: { "goal-verify": {} } }))
    await hooks.tool.goal_set.execute({ objective: "unfinished" }, { sessionID: "parent" })
    const result = JSON.parse(await hooks.tool.goal_complete.execute({ summary: "done" }, { sessionID: "parent" }))
    assert.equal(result.ok, false)
    assert.equal(audits, 0)
  } finally { await hooks.dispose() }
})

test("same-location setup retires the previous instance instead of stealing a live lease", async () => {
  let disposals = 0
  const factory = async () => ({ config: async () => {}, dispose: async () => { disposals++ } })
  const firstCtx = createFakeCtx({ pluginOptions: { registerAgents: false } }).ctx
  const secondCtx = createFakeCtx({ pluginOptions: { registerAgents: false } }).ctx
  const first = await createV2Setup(factory)(firstCtx)
  const second = await createV2Setup(factory)(secondCtx)
  assert.equal(disposals, 1)
  await first()
  assert.equal(disposals, 1, "a later host cleanup is idempotent")
  await second()
  assert.equal(disposals, 2)
})

test("setup registers every V2 surface the goal workflow needs", async () => {
  const { ctx, registered } = createFakeCtx()
  const cleanup = await createV2Setup(GoalPlugin)(ctx)

  try {
    assert.ok(registered.sessionHooks.prompt?.length, "prompt hook (V1 chat.message)")
    assert.equal(registered.sessionHooks.context?.length, 2, "context hook for chat.params and system transform")
    assert.ok(registered.sessionHooks.compaction?.length, "compaction hook")
    assert.ok(registered.toolHooks["execute.before"]?.length, "tool guard hook")

    const goalTools = registered.tools[0].added
    for (const name of ["goal_status", "goal_set", "goal_pause", "goal_resume", "goal_block", "goal_complete"]) {
      assert.ok(goalTools.has(name), `canonical tool ${name} registered`)
    }
    assert.ok(!goalTools.has("set_goal") && !goalTools.has("get_goal"), "redundant legacy aliases are not exposed on V2")
    for (const name of ["get_goal_history", "update_goal", "clear_goal"]) {
      assert.ok(goalTools.has(name), `legacy tool without a canonical twin (${name}) stays`)
    }

    // Zod v4 is Standard Schema v1, which V2 accepts directly; a raw shape
    // object would silently produce an empty input schema.
    const definition = goalTools.get("goal_set")
    assert.equal(typeof definition.execute, "function")
    assert.ok(definition.input?.["~standard"], "input must be a Standard Schema, not a raw shape")
    assert.ok(z.toJSONSchema(definition.input).properties.objective, "objective survives schema conversion")

    const agents = registered.agents[0].store
    assert.ok(agents.has("goal"), "native goal agent registered")
    const verifier = agents.get("goal-verify")
    assert.equal(verifier.mode, "subagent")
    assert.ok(verifier.system.length > 0)

    const command = registered.commands[0].stored || registered.commands[0].store.get("goal")
    assert.ok(command, "goal command registered")
    assert.equal(command.description, GOAL_COMMAND_DESCRIPTION)
    assert.equal(typeof command.execute, "function")
  } finally {
    await cleanup()
  }
})

test("setup is idempotent about cleanup: hooks, transforms, and core all dispose", async () => {
  const { ctx, registrations } = createFakeCtx()
  const cleanup = await createV2Setup(GoalPlugin)(ctx)
  await cleanup()
  await cleanup()
  assert.ok(registrations.includes("session:prompt"))
  assert.ok(registrations.includes("tool.transform"))
  assert.ok(registrations.includes("agent.transform"))
  assert.ok(registrations.includes("command.transform"))
})

/* ------------------------------------------------------------------ *
 * End-to-end: the correlation path that makes /goal work at all
 * ------------------------------------------------------------------ */

test("a V2 command turn creates a goal instead of pausing it as user input", async () => {
  const { ctx, calls, registered } = createFakeCtx({
    pluginOptions: { persistState: false },
  })
  const cleanup = await createV2Setup(GoalPlugin)(ctx)

  try {
    const command = registered.commands[0].store.get("goal")
    assert.ok(command, "command registered")

    await command.execute({
      sessionID: "s1",
      prompt: { text: '"ship the release"' },
      delivery: "steer",
    })

    // The plugin routed its own result as the model turn, marked so the
    // prompt hook can correlate it back to this exact command.
    assert.equal(calls.prompt.length, 1)
    const submission = calls.prompt[0]
    assert.equal(submission.sessionID, "s1")
    assert.match(submission.text, /ship the release/)
    assert.equal(submission.metadata["opencode-goal-plugin"].kind, "command")

    // Replay the host: the same prompt arrives at the V2 prompt hook with the
    // message id the host assigned.
    for (const hook of registered.sessionHooks.prompt) {
      await hook({
        sessionID: "s1",
        messageID: "msg-1",
        prompt: { text: submission.text },
        metadata: submission.metadata,
        delivery: "steer",
      })
    }

    const goals = testInternals.listSessionGoals("s1")
    assert.equal(goals.length, 1, "goal created; the command turn must not be read as user intervention")
    assert.equal(goals[0].condition, "ship the release")
    assert.equal(goals[0].stopped, false)
  } finally {
    await cleanup()
  }
})

test("an unmarked user prompt pauses a running goal as user intervention", async () => {
  const { ctx, calls, registered } = createFakeCtx({
    pluginOptions: { persistState: false },
  })
  const cleanup = await createV2Setup(GoalPlugin)(ctx)

  try {
    const command = registered.commands[0].store.get("goal")
    await command.execute({ sessionID: "s1", prompt: { text: '"ship the release"' }, delivery: "steer" })
    const submission = calls.prompt[0]
    for (const hook of registered.sessionHooks.prompt) {
      await hook({
        sessionID: "s1",
        messageID: "msg-1",
        prompt: { text: submission.text },
        metadata: submission.metadata,
        delivery: "steer",
      })
    }
    assert.equal(testInternals.listSessionGoals("s1")[0].stopped, false)

    // A real human message arrives: latest instruction wins.
    for (const hook of registered.sessionHooks.prompt) {
      await hook({
        sessionID: "s1",
        messageID: "msg-2",
        prompt: { text: "actually stop" },
        metadata: {},
        delivery: "steer",
      })
    }

    const goal = testInternals.listSessionGoals("s1")[0]
    assert.equal(goal.stopped, true)
    assert.equal(goal.stopReason, "user intervention")
  } finally {
    await cleanup()
  }
})

test("context hooks feed the planning-only restriction and the system block", async () => {
  const { ctx, registered } = createFakeCtx({ pluginOptions: { persistState: false } })
  const cleanup = await createV2Setup(GoalPlugin)(ctx)

  try {
    for (const hook of registered.sessionHooks.context) {
      await hook({
        sessionID: "s1",
        agent: "build",
        model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
        system: [{ type: "text", text: "base system prompt" }],
        messages: [],
        options: {},
        tools: {},
      })
    }

    // The system-transform hook must have pushed a goal block into `system`
    // without dropping the host's own system prompt.
    const contextEvent = {
      sessionID: "s1",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      system: [{ type: "text", text: "base system prompt" }],
      messages: [],
      options: {},
      tools: {},
    }
    const [, systemHook] = registered.sessionHooks.context
    await systemHook(contextEvent)
    // No active goal and no guarded command turn: nothing is injected, and the
    // host's system prompt is left byte-for-byte intact.
    assert.deepEqual(contextEvent.system, [{ type: "text", text: "base system prompt" }])
  } finally {
    await cleanup()
  }
})

test("a config command with the same name is re-asserted after activation", async () => {
  const { ctx, registered } = createFakeCtx({
    // Simulates OpenCode 2's `internal.post` config command registration,
    // which lands after user plugins and would otherwise shadow `/goal`.
    commands: [{ name: "goal", description: "Set a session-scoped goal and auto-continue until complete." }],
    pluginOptions: { persistState: false },
  })
  const cleanup = await createV2Setup(GoalPlugin)(ctx)

  try {
    assert.equal(registered.commands.length, 1, "plugin registers once during setup")

    // The boot stream carries `command.updated`; the bridge defers a
    // ownership check behind it, then re-registers so its definition wins.
    ctx.__emit?.({ id: "c1", type: "command.updated", data: {}, location: { directory: "C:\\proj" } })
    await settle(4)
    await new Promise((resolve) => setTimeout(resolve, 1300))
    await settle(4)

    assert.ok(
      registered.commands.length >= 2,
      "plugin re-asserts its command registration when a foreign definition owns the name",
    )
    const latest = registered.commands.at(-1)
    assert.equal(latest.store.get("goal").description, GOAL_COMMAND_DESCRIPTION)
  } finally {
    await cleanup()
  }
})

test("event subscription drives the V1 event hook and survives handler errors", async () => {
  const seen = []
  let factoryHooks = null
  const factory = async () => {
    factoryHooks = {
      config: async () => {},
      "chat.params": async () => {},
      "chat.message": async () => {},
      "tool.execute.before": async () => {},
      "command.execute.before": async () => {},
      event: async ({ event }) => {
        seen.push(event.type)
        if (event.type === "session.status" && event.properties.status?.type === "busy") {
          throw new Error("handler exploded")
        }
      },
      "experimental.chat.system.transform": async () => {},
      "experimental.session.compacting": async () => {},
      dispose: async () => {},
    }
    return factoryHooks
  }

  const { ctx } = createFakeCtx({
    events: [
      { id: "1", type: "session.execution.started", data: { sessionID: "s1" }, location: { directory: "C:\\proj" } },
      { id: "2", type: "session.execution.succeeded", data: { sessionID: "s1" }, location: { directory: "C:\\other" } },
      { id: "3", type: "session.execution.succeeded", data: { sessionID: "s1" }, location: { directory: "C:\\proj" } },
      { id: "4", type: "plugin.updated", data: {} },
    ],
  })
  const cleanup = await createV2Setup(factory)(ctx)
  await settle()
  await cleanup()

  // A throwing handler must not kill the subscription (it is the only
  // auto-continue driver), and foreign-location events never arrive.
  assert.deepEqual(seen, ["session.status", "session.idle"])
})
