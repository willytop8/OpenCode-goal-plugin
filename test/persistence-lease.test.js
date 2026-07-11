import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { acquirePersistenceLease } from "../src/persistence-lease.js"

test("persistence lease rejects a concurrent owner and releases by token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-"))
  const state = join(dir, "state.json")
  const first = await acquirePersistenceLease(state)
  await assert.rejects(acquirePersistenceLease(state), /already owned/)
  assert.equal(await first.release(), true)
  const second = await acquirePersistenceLease(state)
  assert.equal(await second.release(), true)
  await rm(dir, { recursive: true, force: true })
})

test("persistence lease reclaims a dead same-host owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-stale-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  await mkdir(lock)
  await writeFile(`${lock}/owner.json`, JSON.stringify({ token: "old", pid: 2_147_483_647, hostname: (await import("node:os")).hostname() }))
  const lease = await acquirePersistenceLease(state)
  const owner = JSON.parse(await readFile(`${lock}/owner.json`, "utf8"))
  assert.notEqual(owner.token, "old")
  await lease.release()
  await rm(dir, { recursive: true, force: true })
})

test("persistence lease prevents a second Node process from owning the same state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-process-"))
  const state = join(dir, "state.json")
  const moduleURL = new URL("../src/persistence-lease.js", import.meta.url).href
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquirePersistenceLease } from ${JSON.stringify(moduleURL)}
    const lease = await acquirePersistenceLease(${JSON.stringify(state)})
    process.stdout.write("READY\\n")
    process.stdin.once("data", async () => { await lease.release(); process.exit(0) })
  `], { stdio: ["pipe", "pipe", "pipe"] })
  try {
    let output = ""
    while (!output.includes("READY")) {
      const [chunk] = await once(child.stdout, "data")
      output += chunk.toString()
    }
    await assert.rejects(acquirePersistenceLease(state), /already owned/)
    child.stdin.write("stop\n")
    const [code] = await once(child, "exit")
    assert.equal(code, 0)
    const lease = await acquirePersistenceLease(state)
    await lease.release()
  } finally {
    if (child.exitCode === null) child.kill()
    await rm(dir, { recursive: true, force: true })
  }
})
