import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"

function sessionStatePath(stateFilePath, sessionID) {
  const key = createHash("sha256").update(sessionID).digest("hex")
  return join(`${stateFilePath}.sessions`, key, "state.json")
}

function spawnGoalProcess(moduleURL, stateFilePath, sessionID, objective, { expectLeaseError = false } = {}) {
  const action = expectLeaseError
    ? `
      try {
        await hooks["command.execute.before"](
          { command: "goal", sessionID: ${JSON.stringify(sessionID)}, arguments: ${JSON.stringify(objective)} },
          { parts: [] },
        )
        process.stdout.write("UNEXPECTED\\n")
        await hooks.dispose()
        process.exit(1)
      } catch (error) {
        process.stdout.write("ERROR:" + (error?.message || error) + "\\n")
        process.exit(0)
      }
    `
    : `
      await hooks["command.execute.before"](
        { command: "goal", sessionID: ${JSON.stringify(sessionID)}, arguments: ${JSON.stringify(objective)} },
        { parts: [] },
      )
      process.stdout.write("READY\\n")
      process.stdin.once("data", async () => {
        await hooks.dispose()
        process.exit(0)
      })
    `
  const source = `
    import { GoalPlugin } from ${JSON.stringify(moduleURL)}
    const client = {
      app: { log: async () => {} },
      session: { messages: async () => ({ data: [] }), promptAsync: async () => ({}) },
    }
    const hooks = await GoalPlugin(
      { client, directory: ${JSON.stringify(tmpdir())} },
      { stateFilePath: ${JSON.stringify(stateFilePath)}, registerTools: false, minDelayMs: 1 },
    )
    ${action}
  `
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  let settled = false
  const ready = new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
      if (stdout.includes(expectLeaseError ? "ERROR:" : "READY")) {
        settled = true
        resolve({ stdout, stderr })
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", fail)
    child.on("exit", (code) => {
      if (!settled) fail(new Error(`goal child exited before readiness (${code}): ${stderr}`))
    })
  })
  return { child, ready, output: () => ({ stdout, stderr }) }
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => child.once("exit", resolve))
}

test("independent sessions in one project persist concurrently in separate shards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-plugin-concurrent-sessions-"))
  const stateFilePath = join(directory, "state.json")
  const moduleURL = new URL("../src/goal-plugin.js", import.meta.url).href
  const sessions = [
    ["session-concurrent-a", "work on alpha"],
    ["session-concurrent-b", "work on beta"],
    ["session-concurrent-c", "work on gamma"],
    ["session-concurrent-d", "work on delta"],
  ]
  const children = sessions.map(([sessionID, objective]) =>
    spawnGoalProcess(moduleURL, stateFilePath, sessionID, objective),
  )
  try {
    await Promise.all(children.map(({ ready }) => ready))
    for (const [sessionID, objective] of sessions) {
      const persisted = JSON.parse(await readFile(sessionStatePath(stateFilePath, sessionID), "utf8"))
      assert.deepEqual(persisted.goals.map((goal) => goal.condition), [objective])
      assert.equal(persisted.goals[0].sessionID, sessionID)
    }
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null) child.stdin.write("stop\n")
    }
    await Promise.all(children.map(({ child }) => waitForExit(child)))
    for (const { child } of children) child.kill()
    await rm(directory, { recursive: true, force: true })
  }
})

test("the same session remains single-writer across processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-plugin-single-session-"))
  const stateFilePath = join(directory, "state.json")
  const moduleURL = new URL("../src/goal-plugin.js", import.meta.url).href
  const first = spawnGoalProcess(moduleURL, stateFilePath, "session-single-writer", "hold the session")
  let second
  try {
    await first.ready
    second = spawnGoalProcess(
      moduleURL,
      stateFilePath,
      "session-single-writer",
      "take the session",
      { expectLeaseError: true },
    )
    const result = await second.ready
    assert.match(result.stdout, /goal persistence is already owned by pid/)
    assert.equal(await waitForExit(second.child), 0)
  } finally {
    if (first.child.exitCode === null) first.child.stdin.write("stop\n")
    await Promise.all([waitForExit(first.child), second ? waitForExit(second.child) : Promise.resolve()])
    first.child.kill()
    second?.child.kill()
    await rm(directory, { recursive: true, force: true })
  }
})
