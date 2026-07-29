#!/usr/bin/env node

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GoalPlugin } from "../src/goal-plugin.js"

const startedAt = performance.now()
const temporaryDirectories = []

function assistantMessage(sessionID, text, id = `assistant-${sessionID}`) {
  return {
    info: {
      id,
      role: "assistant",
      sessionID,
      tokens: { input: 20, output: 120, reasoning: 0 },
    },
    parts: [{ type: "text", text }],
  }
}

function createHost(messageForSession = () => "Working with tools.") {
  const prompts = []
  const notices = []
  const sourceTurns = new Map()
  return {
    prompts,
    notices,
    client: {
      app: { log: async () => {} },
      session: {
        messages: async ({ path }) => {
          const turn = sourceTurns.get(path.id) || 0
          return {
            data: [
              assistantMessage(
                path.id,
                messageForSession(path.id, turn),
                `assistant-${path.id}-${turn}`,
              ),
            ],
          }
        },
        promptAsync: async (input) => {
          prompts.push(input)
          const sessionID = input?.sessionID || input?.path?.id
          if (sessionID) sourceTurns.set(sessionID, (sourceTurns.get(sessionID) || 0) + 1)
          return {}
        },
      },
    },
  }
}

function promptCharacters(prompts) {
  return prompts.reduce(
    (total, prompt) => total + (prompt?.body?.parts || []).reduce(
      (partTotal, part) => partTotal + (typeof part?.text === "string" ? part.text.length : 0),
      0,
    ),
    0,
  )
}

function sessionStatePath(stateFilePath, sessionID) {
  const key = createHash("sha256").update(sessionID).digest("hex")
  return join(`${stateFilePath}.sessions`, key, "state.json")
}

async function makeDirectory(label) {
  const directory = await fs.mkdtemp(join(tmpdir(), `goal-benchmark-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

async function createHooks(host, options = {}) {
  return GoalPlugin(
    { client: host.client, directory: await makeDirectory("workspace") },
    {
      persistState: false,
      registerTools: false,
      registerAgents: false,
      minDelayMs: 1,
      noProgressTokenThreshold: 1,
      noProgressTurnsBeforePause: 10,
      noToolCallTurnsBeforePause: 2,
      ...options,
    },
  )
}

async function goalCommand(hooks, sessionID, argumentsText) {
  const output = { parts: [] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: argumentsText },
    output,
  )
  return output.parts.map((part) => part.text || "").join("\n")
}

async function idle(hooks, sessionID, id) {
  await hooks.event({
    event: {
      id,
      type: "session.status",
      properties: { sessionID, status: { type: "idle" } },
    },
  })
}

async function scenario(name, points, run) {
  const scenarioStartedAt = performance.now()
  try {
    const telemetry = await run()
    return {
      name,
      passed: true,
      points,
      durationMs: Number((performance.now() - scenarioStartedAt).toFixed(2)),
      ...telemetry,
    }
  } catch (error) {
    return {
      name,
      passed: false,
      points: 0,
      possiblePoints: points,
      durationMs: Number((performance.now() - scenarioStartedAt).toFixed(2)),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const results = []

results.push(await scenario("verified-success", 20, async () => {
  const sessionID = "benchmark-success"
  const host = createHost(() => "Tests pass.\n[goal:evidence] npm test: 210/210\n[goal:complete]")
  const hooks = await createHooks(host, {
    auditor: async () => ({ approved: true, reason: "evidence independently accepted" }),
  })
  await goalCommand(hooks, sessionID, "ship a verified release")
  await idle(hooks, sessionID, "success-idle")
  const status = await goalCommand(hooks, sessionID, "status")
  assert.match(status, /State: achieved/)
  await hooks.dispose()
  return {
    continuationPrompts: host.prompts.length,
    continuationCharacters: promptCharacters(host.prompts),
    status: "archived",
  }
}))

results.push(await scenario("false-completion", 20, async () => {
  const sessionID = "benchmark-false-completion"
  const host = createHost(() => "Looks done.\n[goal:evidence] guessed from source\n[goal:complete]")
  const hooks = await createHooks(host, {
    auditor: async () => ({ approved: false, reason: "no executed verification" }),
  })
  await goalCommand(hooks, sessionID, "do not accept an unverified claim")
  await idle(hooks, sessionID, "false-idle")
  const status = await goalCommand(hooks, sessionID, "status")
  assert.match(status, /audit rejected/i)
  assert.doesNotMatch(status, /No active goal/)
  await hooks.dispose()
  return {
    continuationPrompts: host.prompts.length,
    continuationCharacters: promptCharacters(host.prompts),
    status: "rejected",
  }
}))

results.push(await scenario("loop-circuit-breaker", 15, async () => {
  const sessionID = "benchmark-loop"
  const host = createHost((_sessionID, turn) => `Still discussing the work, turn ${turn}.`)
  const hooks = await createHooks(host)
  await goalCommand(hooks, sessionID, "stop self-chat loops")
  await idle(hooks, sessionID, "loop-1")
  await idle(hooks, sessionID, "loop-2")
  await idle(hooks, sessionID, "loop-3")
  const status = await goalCommand(hooks, sessionID, "status")
  assert.match(status, /no tool calls|self-chat loop/i)
  assert.equal(host.prompts.length, 2)
  await hooks.dispose()
  return {
    continuationPrompts: host.prompts.length,
    continuationCharacters: promptCharacters(host.prompts),
    status: "paused",
  }
}))

results.push(await scenario("human-interruption", 15, async () => {
  const sessionID = "benchmark-interruption"
  const host = createHost()
  const hooks = await createHooks(host)
  await goalCommand(hooks, sessionID, "respect explicit interruption")
  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID,
        error: { name: "MessageAbortedError", message: "aborted by user" },
      },
    },
  })
  await idle(hooks, sessionID, "interruption-idle")
  assert.equal(host.prompts.length, 0)
  assert.match(await goalCommand(hooks, sessionID, "status"), /abort|paused|stopped/i)
  await hooks.dispose()
  return { continuationPrompts: 0, status: "paused" }
}))

results.push(await scenario("compaction-continuity", 15, async () => {
  const sessionID = "benchmark-compaction"
  const host = createHost()
  const hooks = await createHooks(host)
  await goalCommand(hooks, sessionID, "preserve the objective across compaction")
  const output = { context: [] }
  await hooks["experimental.session.compacting"]({ sessionID }, output)
  assert.equal(output.context.length, 1)
  assert.match(output.context[0], /preserve the objective across compaction/)
  assert.ok(output.context[0].length < 2_000, "compaction context exceeded token-efficient size cap")
  await hooks.dispose()
  return {
    contextCharacters: output.context[0].length,
    estimatedContextTokens: Math.ceil(output.context[0].length / 4),
    status: "preserved",
  }
}))

results.push(await scenario("restart-recovery", 15, async () => {
  const sessionID = "benchmark-restart"
  const directory = await makeDirectory("restart")
  const stateFilePath = join(directory, "state.json")
  const host = createHost()
  const first = await GoalPlugin(
    { client: host.client, directory },
    { persistState: true, stateFilePath, registerTools: false, registerAgents: false, minDelayMs: 1 },
  )
  await goalCommand(first, sessionID, "recover safely after restart")
  await first.dispose()
  const second = await GoalPlugin(
    { client: host.client, directory },
    { persistState: true, stateFilePath, registerTools: false, registerAgents: false, minDelayMs: 1 },
  )
  const status = await goalCommand(second, sessionID, "status")
  assert.match(status, /Recovered persisted goal state|recovered after restart/i)
  await idle(second, sessionID, "restart-idle")
  assert.equal(host.prompts.length, 0, "recovered goals must not resume without user consent")
  const stateBytes = (await fs.stat(sessionStatePath(stateFilePath, sessionID))).size
  await second.dispose()
  return { continuationPrompts: 0, persistedStateBytes: stateBytes, status: "recovered-paused" }
}))

const score = results.reduce((total, result) => total + result.points, 0)
const possibleScore = 100
const continuationCharacters = results.reduce(
  (total, result) => total + (result.continuationCharacters || 0),
  0,
)
const report = {
  schemaVersion: 1,
  benchmark: "opencode-goal-plugin-behavior",
  score,
  possibleScore,
  passed: score === possibleScore,
  durationMs: Number((performance.now() - startedAt).toFixed(2)),
  efficiency: {
    totalContinuationPrompts: results.reduce(
      (total, result) => total + (result.continuationPrompts || 0),
      0,
    ),
    continuationCharacters,
    estimatedContinuationTokens: Math.ceil(continuationCharacters / 4),
    modelCalls: 0,
    externalRequests: 0,
  },
  scenarios: results,
}

for (const directory of temporaryDirectories) {
  await fs.rm(directory, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.passed) process.exitCode = 1
