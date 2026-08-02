import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { promises as sharedFs } from "node:fs"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"
import { GoalPlugin } from "../src/goal-plugin.js"
import { acquirePersistenceLease } from "../src/persistence-lease.js"

function sessionStatePath(stateFilePath, sessionID) {
  const key = createHash("sha256").update(sessionID).digest("hex")
  return join(`${stateFilePath}.sessions`, key, "state.json")
}

function spawnGoalProcess(moduleURL, stateFilePath, sessionID, objective) {
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
      if (stdout.includes("READY")) {
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

test("fresh namespaces serialize migration-marker publication", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-plugin-fresh-migration-"))
  const stateFilePath = join(directory, "state.json")
  const migrationMarkerPath = join(`${stateFilePath}.sessions`, ".migration-v1-complete")
  const migrationLockPath = `${stateFilePath}.lock`
  const originalLstat = sharedFs.lstat
  let observedMigrationLock
  const migrationLockObserved = new Promise((resolve) => {
    observedMigrationLock = resolve
  })
  let migrationBlocker = await acquirePersistenceLease(stateFilePath)
  let releasedLease
  let hooks
  let loading
  sharedFs.lstat = async (...args) => {
    if (args[0] === migrationLockPath) observedMigrationLock()
    return originalLstat(...args)
  }

  try {
    hooks = await GoalPlugin(
      {
        client: {
          app: { log: async () => {} },
          session: { messages: async () => ({ data: [] }), promptAsync: async () => ({}) },
        },
        directory,
      },
      { stateFilePath, registerTools: false, minDelayMs: 1 },
    )
    let loadSettled = false
    loading = hooks["chat.params"]({ sessionID: "fresh-migration-session", agent: "build" })
      .then((value) => {
        loadSettled = true
        return value
      })

    const firstBoundary = await Promise.race([
      migrationLockObserved.then(() => "lock"),
      loading.then(() => "loaded"),
    ])
    assert.equal(
      firstBoundary,
      "lock",
      "fresh migration must consult the aggregate lease before publishing its marker",
    )
    assert.equal(loadSettled, false, "fresh session loading must wait for migration ownership")
    await assert.rejects(stat(migrationMarkerPath), { code: "ENOENT" })

    await migrationBlocker.release()
    migrationBlocker = null
    await loading
    const marker = JSON.parse(await readFile(migrationMarkerPath, "utf8"))
    assert.equal(marker.version, 1)
    assert.equal(Number.isFinite(marker.migratedAt), true)
    releasedLease = await acquirePersistenceLease(stateFilePath)
    assert.ok(releasedLease, "fresh migration must release the aggregate lease after publishing")
    await releasedLease.release()
    releasedLease = null
  } finally {
    sharedFs.lstat = originalLstat
    await migrationBlocker?.release().catch(() => false)
    await releasedLease?.release().catch(() => false)
    await Promise.allSettled([loading].filter(Boolean))
    await hooks?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

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

test("a same-session process contender stays passive and takes over only after an explicit retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-plugin-single-session-"))
  const stateFilePath = join(directory, "state.json")
  const moduleURL = new URL("../src/goal-plugin.js", import.meta.url).href
  const first = spawnGoalProcess(moduleURL, stateFilePath, "session-single-writer", "hold the session")
  const promptCalls = []
  const messageCalls = []
  const logs = []
  let hostMessages = []
  let contender
  try {
    await first.ready
    const persistedBefore = await readFile(
      sessionStatePath(stateFilePath, "session-single-writer"),
      "utf8",
    )

    contender = await GoalPlugin(
      {
        client: {
          app: { log: async (input) => logs.push(input) },
          session: {
            messages: async (input) => {
              messageCalls.push(input)
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
      { stateFilePath, registerTools: false, minDelayMs: 1 },
    )

    await assert.doesNotReject(() =>
      contender["chat.params"]({ sessionID: "session-single-writer", agent: "build" }),
    )
    const denial = {
      message: { id: "passive-command", role: "user", sessionID: "session-single-writer" },
      parts: [],
    }
    await contender["command.execute.before"](
      { command: "goal", sessionID: "session-single-writer", arguments: "status" },
      denial,
    )
    assert.match(denial.parts[0].text, /Goal controls are unavailable/)
    Object.assign(denial.parts[0], {
      id: "passive-command-part",
      messageID: "passive-command",
      sessionID: "session-single-writer",
    })
    await contender["chat.message"](
      { sessionID: "session-single-writer", messageID: "passive-command", agent: "build" },
      denial,
    )
    hostMessages = [{
      info: {
        id: "passive-command-assistant",
        parentID: "passive-command",
        role: "assistant",
        sessionID: "session-single-writer",
      },
      parts: [{ type: "text", text: "Ownership denial reported." }],
    }]
    await contender.event({
      event: {
        type: "session.status",
        properties: { sessionID: "session-single-writer", status: { type: "idle" } },
      },
    })
    assert.equal(
      await readFile(sessionStatePath(stateFilePath, "session-single-writer"), "utf8"),
      persistedBefore,
    )
    assert.equal(promptCalls.length, 0)
    assert.equal(messageCalls.length, 1)
    assert.equal(logs.length, 1)

    first.child.stdin.write("stop\n")
    assert.equal(await waitForExit(first.child), 0)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const ordinaryParts = [{ type: "text", text: "ordinary chat after owner exit" }]
    await contender["chat.message"](
      { sessionID: "session-single-writer", messageID: "ordinary-after-exit", agent: "build" },
      {
        message: { id: "ordinary-after-exit", role: "user", sessionID: "session-single-writer" },
        parts: ordinaryParts,
      },
    )
    assert.equal(ordinaryParts[0].text, "ordinary chat after owner exit")
    const releasedLockPath = `${sessionStatePath(stateFilePath, "session-single-writer")}.lock`
    const sentinel = JSON.parse(await readFile(releasedLockPath, "utf8"))
    assert.equal(sentinel.protocol, 2)
    assert.equal(sentinel.sentinel, true)
    assert.deepEqual(
      (await readdir(`${releasedLockPath}.claims-v2`))
        .filter((name) => name.startsWith("claim-")),
      [],
    )

    const takeover = { parts: [] }
    await contender["command.execute.before"](
      { command: "goal", sessionID: "session-single-writer", arguments: "status" },
      takeover,
    )
    assert.match(takeover.parts[0].text, /hold the session/)
    assert.match(takeover.parts[0].text, /recovered after restart|paused|stopped/i)
    await contender.event({
      event: {
        type: "session.status",
        properties: { sessionID: "session-single-writer", status: { type: "idle" } },
      },
    })
    assert.equal(promptCalls.length, 0)
  } finally {
    if (first.child.exitCode === null) first.child.stdin.write("stop\n")
    await waitForExit(first.child)
    await contender?.dispose()
    first.child.kill()
    await rm(directory, { recursive: true, force: true })
  }
})
