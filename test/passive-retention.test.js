import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { GoalPlugin, testInternals } from "../src/goal-plugin.js"

function sessionPaths(stateFilePath, sessionID) {
  return testInternals.sessionPathsFor({ sessionDirectory: `${stateFilePath}.sessions` }, sessionID)
}

test("passive session tombstones are not evicted before an explicit takeover", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "goal-plugin-passive-retention-"))
  const stateFilePath = join(directory, "state.json")
  const sessionIDs = Array.from({ length: 1001 }, (_, index) => `contended-session-${index}`)
  const firstSessionID = sessionIDs[0]
  const legacyOwner = JSON.stringify({
    token: "legacy-owner",
    pid: 4242,
    hostname: "legacy.remote.example",
  })
  const originalNow = Date.now
  const observedAt = originalNow()
  let hooks
  try {
    Date.now = () => observedAt
    hooks = await GoalPlugin(
      {
        client: {
          app: { log: async () => {} },
          session: {
            messages: async () => ({ data: [] }),
            promptAsync: async () => ({}),
          },
        },
        directory,
      },
      { stateFilePath, registerTools: false, minDelayMs: 1 },
    )

    for (const sessionID of sessionIDs) {
      const paths = sessionPaths(stateFilePath, sessionID)
      await fs.mkdir(`${paths.stateFilePath}.lock`, { recursive: true })
      await fs.writeFile(`${paths.stateFilePath}.lock/owner.json`, legacyOwner)
      await hooks["chat.params"]({ sessionID, agent: "build" })
    }

    assert.equal(testInternals.runtimeSessionDiagnostics(firstSessionID).passive, true)
    const firstLockPath = `${sessionPaths(stateFilePath, firstSessionID).stateFilePath}.lock`
    await fs.rm(firstLockPath, { recursive: true })

    const ordinaryOutput = {
      message: { id: "ordinary-after-many-passive", role: "user", sessionID: firstSessionID },
      parts: [{ type: "text", text: "ordinary chat must not acquire the lease" }],
    }
    Date.now = () => observedAt + 1_000
    await hooks["chat.message"](
      { sessionID: firstSessionID, messageID: "ordinary-after-many-passive", agent: "build" },
      ordinaryOutput,
    )
    assert.equal(ordinaryOutput.parts[0].text, "ordinary chat must not acquire the lease")
    await assert.rejects(fs.stat(firstLockPath), { code: "ENOENT" })

    const explicitStatus = { parts: [] }
    await hooks["command.execute.before"](
      { command: "goal", sessionID: firstSessionID, arguments: "status" },
      explicitStatus,
    )
    assert.match(explicitStatus.parts[0].text, /No active goal/)
    assert.equal(testInternals.runtimeSessionDiagnostics(firstSessionID).persistenceOwned, true)
  } finally {
    Date.now = originalNow
    await hooks?.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
