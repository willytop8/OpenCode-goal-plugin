import assert from "node:assert/strict"
import nodeTest from "node:test"
import { randomUUID } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  lstat,
  link,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import {
  acquirePersistenceLease,
  isPersistenceLeaseContendedError,
  PERSISTENCE_LEASE_CONTENDED,
  PersistenceLeaseContendedError,
  persistenceLeaseInternals,
} from "../src/persistence-lease.js"

// Every test in this file waits on real filesystem locking, and several of the
// mutation-contract mutants remove the very guard that lets one of those waits
// finish. An unbounded test does not then fail — it hangs the whole run until
// CI's job timeout, reporting nothing about which mutant caused it. Node 18 has
// no `--test-timeout`, so the bound is applied here instead. Generous on
// purpose: normal runs finish in milliseconds, so this only ever fires on a
// genuine hang, never on a slow runner.
const LEASE_TEST_TIMEOUT_MS = 30_000
const test = (name, options, run) =>
  typeof options === "function"
    ? nodeTest(name, { timeout: LEASE_TEST_TIMEOUT_MS }, options)
    : nodeTest(name, { timeout: LEASE_TEST_TIMEOUT_MS, ...options }, run)

async function createV2LeaseDirectory(lockPath) {
  const guard = await persistenceLeaseInternals.publishLegacyGuard(lockPath)
  await mkdir(persistenceLeaseInternals.claimDirectoryPathFor(lockPath))
  return guard.owner
}

async function claimNames(lockPath) {
  return (await readdir(persistenceLeaseInternals.claimDirectoryPathFor(lockPath)))
    .filter((name) => name.startsWith("claim-"))
    .sort()
}

function deferred() {
  let resolve
  const promise = new Promise((settle) => { resolve = settle })
  return { promise, resolve }
}

async function readVersion1Owner(lockPath) {
  try {
    return JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"))
  } catch {
    return null
  }
}

async function acquireVersion1Lease(
  stateFilePath,
  {
    malformedGraceMs = 30_000,
    now = () => Date.now(),
    beforeOwnerWrite,
    beforeStaleRename,
    afterStaleRemoval,
  } = {},
) {
  const lockPath = `${stateFilePath}.lock`
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      await beforeOwnerWrite?.({ attempt, lockPath, owner: { ...owner } })
      await writeFile(join(lockPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 })
      return {
        owner,
        async release() {
          const current = await readVersion1Owner(lockPath)
          if (current?.token !== owner.token) return false
          await rm(lockPath, { recursive: true, force: true })
          return true
        },
      }
    } catch (error) {
      if (error?.code !== "EEXIST") {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      const existing = await readVersion1Owner(lockPath)
      const sameHost = existing?.hostname === owner.hostname
      let reclaimableMalformed = false
      if (!existing) {
        try {
          const info = await lstat(lockPath)
          reclaimableMalformed = now() - info.mtimeMs >= malformedGraceMs
        } catch (statError) {
          if (statError?.code === "ENOENT") continue
        }
      }
      if (
        (sameHost && persistenceLeaseInternals.processIsAlive(existing?.pid) === false) ||
        reclaimableMalformed
      ) {
        await beforeStaleRename?.({ attempt, lockPath, owner: { ...owner } })
        const stalePath = `${lockPath}.stale.${randomUUID()}`
        try {
          await fsRename(lockPath, stalePath)
          await rm(stalePath, { recursive: true, force: true })
          await afterStaleRemoval?.({ attempt, lockPath, owner: { ...owner } })
          continue
        } catch (reclaimError) {
          if (reclaimError?.code === "ENOENT") continue
        }
      }
      throw new Error("version-1 lease contended")
    }
  }
  throw new Error("version-1 lease exhausted")
}

test("persistence lease rejects a concurrent owner and releases by token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-"))
  const state = join(dir, "state.json")
  const first = await acquirePersistenceLease(state)
  await assert.rejects(acquirePersistenceLease(state), (error) => {
    assert.equal(error instanceof PersistenceLeaseContendedError, true)
    assert.equal(isPersistenceLeaseContendedError(error), true)
    assert.equal(error.code, PERSISTENCE_LEASE_CONTENDED)
    assert.equal(error.owner.pid, process.pid)
    assert.equal(typeof error.owner.hostname, "string")
    assert.equal(Object.isFrozen(error.owner), true)
    assert.equal(error.reason, "owned_elsewhere")
    assert.equal("token" in error.owner, false)
    assert.doesNotMatch(error.message, /state\.json/i)
    assert.equal(error.message.includes(first.owner.token), false)
    return true
  })
  const sentinelBeforeRelease = await readFile(`${state}.lock`, "utf8")
  assert.equal(
    persistenceLeaseInternals.validLegacySentinel(JSON.parse(sentinelBeforeRelease)),
    true,
  )
  assert.equal(
    isPersistenceLeaseContendedError({ code: PERSISTENCE_LEASE_CONTENDED }),
    false,
  )
  assert.equal(await first.release(), true)
  assert.equal(await readFile(`${state}.lock`, "utf8"), sentinelBeforeRelease)
  assert.deepEqual(await claimNames(`${state}.lock`), [])
  const second = await acquirePersistenceLease(state)
  assert.equal(await second.release(), true)
  assert.equal(await readFile(`${state}.lock`, "utf8"), sentinelBeforeRelease)
  await rm(dir, { recursive: true, force: true })
})

test("version 1 wins safely when its legacy directory is created first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-v1-first-"))
  const state = join(dir, "state.json")
  const atOwnerWrite = deferred()
  const allowOwnerWrite = deferred()
  let version1Lease
  try {
    const version1 = acquireVersion1Lease(state, {
      beforeOwnerWrite: async () => {
        atOwnerWrite.resolve()
        await allowOwnerWrite.promise
      },
    })
    await atOwnerWrite.promise

    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), true)
      assert.equal(error.reason, "legacy_lock")
      return true
    })

    allowOwnerWrite.resolve()
    version1Lease = await version1
    assert.equal(
      JSON.parse(await readFile(`${state}.lock/owner.json`, "utf8")).token,
      version1Lease.owner.token,
    )
    await assert.rejects(stat(persistenceLeaseInternals.claimDirectoryPathFor(`${state}.lock`)), {
      code: "ENOENT",
    })
  } finally {
    allowOwnerWrite.resolve()
    await version1Lease?.release()
    await rm(dir, { recursive: true, force: true })
  }
})

test("an atomically published version-2 guard makes exact version 1 fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-v2-first-"))
  const state = join(dir, "state.json")
  const guardLinked = deferred()
  const allowV2Claims = deferred()
  let version2Lease
  try {
    const version2 = persistenceLeaseInternals.acquirePersistenceLeaseWithHooks(
      state,
      {},
      {
        afterGuardLink: async () => {
          guardLinked.resolve()
          await allowV2Claims.promise
        },
      },
    )
    await guardLinked.promise

    await assert.rejects(acquireVersion1Lease(state), /version-1 lease contended/)
    const guardInfo = await stat(`${state}.lock`)
    assert.equal(guardInfo.isFile(), true)
    assert.equal(persistenceLeaseInternals.legacyGuardMtimeIsSafe(guardInfo), true)

    allowV2Claims.resolve()
    version2Lease = await version2
    assert.deepEqual(await claimNames(`${state}.lock`), [
      persistenceLeaseInternals.claimNameFor(version2Lease.owner.token),
    ])
  } finally {
    allowV2Claims.resolve()
    await version2Lease?.release()
    await rm(dir, { recursive: true, force: true })
  }
})

test("version 2 stays passive while version 1 is paused after a stale decision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-v1-stale-decision-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const staleDecision = deferred()
  const allowStaleRename = deferred()
  let version1Lease
  try {
    await mkdir(lock)
    await writeFile(join(lock, "owner.json"), JSON.stringify({
      token: "old",
      pid: 2_147_483_647,
      hostname: hostname(),
    }))
    const version1 = acquireVersion1Lease(state, {
      beforeStaleRename: async () => {
        staleDecision.resolve()
        await allowStaleRename.promise
      },
    })
    await staleDecision.promise

    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), true)
      assert.equal(error.reason, "legacy_lock")
      return true
    })

    allowStaleRename.resolve()
    version1Lease = await version1
    assert.equal(
      JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).token,
      version1Lease.owner.token,
    )
  } finally {
    allowStaleRename.resolve()
    await version1Lease?.release()
    await rm(dir, { recursive: true, force: true })
  }
})

test("version 2 wins safely while version 1 pauses after removing a stale directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-v1-stale-removed-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const staleRemoved = deferred()
  const allowVersion1Retry = deferred()
  let version2Lease
  try {
    await mkdir(lock)
    await writeFile(join(lock, "owner.json"), JSON.stringify({
      token: "old",
      pid: 2_147_483_647,
      hostname: hostname(),
    }))
    const version1 = acquireVersion1Lease(state, {
      afterStaleRemoval: async () => {
        staleRemoved.resolve()
        await allowVersion1Retry.promise
      },
    })
    await staleRemoved.promise

    version2Lease = await acquirePersistenceLease(state)
    allowVersion1Retry.resolve()
    await assert.rejects(version1, /version-1 lease contended/)
    assert.deepEqual(await claimNames(lock), [
      persistenceLeaseInternals.claimNameFor(version2Lease.owner.token),
    ])
  } finally {
    allowVersion1Retry.resolve()
    await version2Lease?.release()
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease fails closed on a dead legacy owner until manual recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-stale-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  await mkdir(lock)
  const legacyOwner = JSON.stringify({ token: "old", pid: 2_147_483_647, hostname: hostname() })
  await writeFile(`${lock}/owner.json`, legacyOwner)
  await utimes(lock, new Date(0), new Date(0))
  await assert.rejects(acquirePersistenceLease(state, { malformedGraceMs: 0 }), (error) => {
    assert.equal(isPersistenceLeaseContendedError(error), true)
    assert.equal(error.reason, "legacy_lock")
    assert.match(error.message, /legacy or incomplete lease.*remove its lease artifacts/i)
    return true
  })
  assert.equal(await readFile(`${lock}/owner.json`, "utf8"), legacyOwner)
  assert.deepEqual(await readdir(lock), ["owner.json"])

  await rm(lock, { recursive: true })
  const lease = await acquirePersistenceLease(state)
  assert.equal(await lease.release(), true)
  await rm(dir, { recursive: true, force: true })
})

test("persistence lease fails closed on fresh and old malformed legacy locks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-malformed-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  await mkdir(lock)
  await writeFile(`${lock}/owner.json`, "{truncated")
  await assert.rejects(acquirePersistenceLease(state, { malformedGraceMs: 30_000 }), (error) => {
    assert.equal(isPersistenceLeaseContendedError(error), true)
    assert.deepEqual(error.owner, { pid: null, hostname: null })
    assert.equal(error.reason, "legacy_lock")
    return true
  })
  await utimes(lock, new Date(0), new Date(0))
  await assert.rejects(acquirePersistenceLease(state, { malformedGraceMs: 1 }), (error) => {
    assert.equal(isPersistenceLeaseContendedError(error), true)
    assert.equal(error.reason, "legacy_lock")
    return true
  })
  assert.equal(await readFile(`${lock}/owner.json`, "utf8"), "{truncated")
  await rm(dir, { recursive: true, force: true })
})

test("persistence lease fails closed on a regular guard without its exact sentinel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-incomplete-v2-"))
  try {
    const invalidGuards = [
      "{truncated",
      JSON.stringify({ ...persistenceLeaseInternals.legacySentinel(), sentinel: false }),
    ]
    for (const [index, contents] of invalidGuards.entries()) {
      const state = join(dir, `state-${index}.json`)
      const lock = `${state}.lock`
      await writeFile(lock, contents)
      await assert.rejects(acquirePersistenceLease(state), (error) => {
        assert.equal(isPersistenceLeaseContendedError(error), true)
        assert.equal(error.reason, "legacy_lock")
        return true
      })
      assert.equal(await readFile(lock, "utf8"), contents)
      await assert.rejects(stat(persistenceLeaseInternals.claimDirectoryPathFor(lock)), {
        code: "ENOENT",
      })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease fails closed when an exact sentinel lacks its future mtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-undated-sentinel-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const sentinel = persistenceLeaseInternals.legacySentinel()
  try {
    await writeFile(lock, JSON.stringify(sentinel))
    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), true)
      assert.equal(error.reason, "legacy_lock")
      return true
    })
    assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), sentinel)
    await assert.rejects(stat(persistenceLeaseInternals.claimDirectoryPathFor(lock)), {
      code: "ENOENT",
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease rejects a future-dated sentinel with extra fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-sentinel-extra-field-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const sentinel = { ...persistenceLeaseInternals.legacySentinel(), extra: "tampered" }
  try {
    await writeFile(lock, JSON.stringify(sentinel))
    const guardDate = new Date("2100-01-01T00:00:00.000Z")
    await utimes(lock, guardDate, guardDate)
    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), true)
      assert.equal(error.reason, "legacy_lock")
      return true
    })
    assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), sentinel)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease fails safely when the filesystem cannot publish a hard link", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-no-hardlink-"))
  const state = join(dir, "state.json")
  try {
    await assert.rejects(
      persistenceLeaseInternals.acquirePersistenceLeaseWithHooks(
        state,
        {},
        {
          linkGuard: async () => {
            const error = new Error("hard links disabled")
            error.code = "ENOTSUP"
            throw error
          },
        },
      ),
      (error) => {
        assert.equal(error.code, "ERR_GOAL_PERSISTENCE_LEASE_HARDLINK")
        assert.match(error.message, /hard-link support/)
        return true
      },
    )
    await assert.rejects(stat(`${state}.lock`), { code: "ENOENT" })
    await assert.rejects(
      stat(persistenceLeaseInternals.claimDirectoryPathFor(`${state}.lock`)),
      { code: "ENOENT" },
    )
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes(".guard.")), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("guard publication retries when a version-1 directory disappears after EEXIST", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-guard-eexist-release-"))
  const state = join(dir, "state.json")
  let linkCalls = 0
  let lease
  try {
    lease = await persistenceLeaseInternals.acquirePersistenceLeaseWithHooks(
      state,
      {},
      {
        linkGuard: async (source, target) => {
          linkCalls += 1
          if (linkCalls === 1) {
            await mkdir(target)
            await rm(target, { recursive: true })
            const error = new Error("legacy directory existed during link")
            error.code = "EEXIST"
            throw error
          }
          await link(source, target)
        },
      },
    )
    assert.equal(linkCalls, 2)
    assert.equal((await stat(`${state}.lock`)).isFile(), true)
    assert.deepEqual(await claimNames(`${state}.lock`), [
      persistenceLeaseInternals.claimNameFor(lease.owner.token),
    ])
  } finally {
    await lease?.release()
    await rm(dir, { recursive: true, force: true })
  }
})

test("a missing final guard cannot return ownership and cleans its published claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-final-guard-missing-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  let linkCalls = 0
  try {
    await assert.rejects(
      persistenceLeaseInternals.acquirePersistenceLeaseWithHooks(
        state,
        {},
        {
          linkGuard: async (source, target) => {
            linkCalls += 1
            if (linkCalls === 1) {
              await link(source, target)
              return
            }
            const error = new Error("legacy path repeatedly raced and disappeared")
            error.code = "EEXIST"
            throw error
          },
          afterOwnerWrite: async () => {
            await rm(lock, { force: true })
          },
        },
      ),
      (error) => {
        assert.equal(isPersistenceLeaseContendedError(error), true)
        assert.equal(error.reason, "owned_elsewhere")
        return true
      },
    )
    assert.equal(linkCalls, 6)
    await assert.rejects(stat(lock), { code: "ENOENT" })
    assert.deepEqual(await claimNames(lock), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease treats schema-invalid JSON owners as malformed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-invalid-owner-schema-"))
  const invalidOwners = [
    {},
    [],
    null,
    { pid: process.pid, hostname: "valid.example" },
    { token: "token", pid: 0, hostname: "valid.example" },
    { token: "token", pid: process.pid, hostname: "" },
  ]
  try {
    for (const [index, owner] of invalidOwners.entries()) {
      const state = join(dir, `state-${index}.json`)
      const lock = `${state}.lock`
      await mkdir(lock)
      await writeFile(`${lock}/owner.json`, JSON.stringify(owner))
      await assert.rejects(acquirePersistenceLease(state), (error) => {
        assert.equal(isPersistenceLeaseContendedError(error), true)
        assert.deepEqual(error.owner, { pid: null, hostname: null })
        assert.equal(error.reason, "legacy_lock")
        return true
      })
      await utimes(lock, new Date(0), new Date(0))
      await assert.rejects(acquirePersistenceLease(state, { malformedGraceMs: 1 }), (error) => {
        assert.equal(error.reason, "legacy_lock")
        return true
      })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease keeps display-unsafe hostnames valid but hides them from diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-display-unsafe-host-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const storedHostname = "valid storage hostname\nnot safe for logs"
  await mkdir(lock)
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({ token: "live-owner", pid: process.pid, hostname: storedHostname }),
  )
  await utimes(lock, new Date(0), new Date(0))
  try {
    await assert.rejects(
      acquirePersistenceLease(state, { malformedGraceMs: 1 }),
      (error) => {
        assert.equal(isPersistenceLeaseContendedError(error), true)
        assert.deepEqual(error.owner, { pid: process.pid, hostname: null })
        assert.equal(error.reason, "legacy_lock")
        assert.doesNotMatch(error.message, /valid storage hostname|not safe for logs/)
        return true
      },
    )
    assert.equal(
      JSON.parse(await readFile(`${lock}/owner.json`, "utf8")).hostname,
      storedHostname,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("bounded owner reads consume legal short reads before parsing", async () => {
  const raw = Buffer.from(
    JSON.stringify({ token: "short-read", pid: process.pid, hostname: "valid.example" }),
  )
  const info = {
    size: raw.length,
    dev: 41,
    ino: 42,
    isFile: () => true,
  }
  let reads = 0
  const handle = {
    async read(buffer, offset, length, position) {
      const bytesRead = Math.min(3, length, Math.max(0, raw.length - position))
      if (bytesRead > 0) raw.copy(buffer, offset, position, position + bytesRead)
      reads += 1
      return { bytesRead, buffer }
    },
    async stat() {
      return info
    },
  }

  assert.equal(
    await persistenceLeaseInternals.readBoundedOwnerFile(handle, info),
    raw.toString("utf8"),
  )
  assert.ok(reads > 1)
})

test("a delayed claim publication cannot overwrite a replacement lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-publication-race-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  let releaseFirstWrite
  let firstWriteStarted
  const firstAtWrite = new Promise((resolve) => { firstWriteStarted = resolve })
  const writeBarrier = new Promise((resolve) => { releaseFirstWrite = resolve })
  let secondLease
  let results
  try {
    const firstLease = persistenceLeaseInternals.acquirePersistenceLeaseWithHooks(
      state,
      { malformedGraceMs: 1 },
      {
        beforeOwnerWrite: async () => {
          firstWriteStarted()
          await writeBarrier
        },
      },
    )
    await firstAtWrite
    const sentinelBefore = await readFile(lock, "utf8")
    assert.equal(
      persistenceLeaseInternals.validLegacySentinel(JSON.parse(sentinelBefore)),
      true,
    )
    assert.equal((await stat(lock)).isFile(), true)
    secondLease = await acquirePersistenceLease(state, { malformedGraceMs: 1 })
    releaseFirstWrite()
    results = await Promise.allSettled([firstLease, Promise.resolve(secondLease)])

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
    assert.equal(results[0].status, "rejected")
    assert.equal(isPersistenceLeaseContendedError(results[0].reason), true)
    assert.equal(await readFile(lock, "utf8"), sentinelBefore)
    assert.deepEqual(await claimNames(lock), [
      persistenceLeaseInternals.claimNameFor(secondLease.owner.token),
    ])
  } finally {
    releaseFirstWrite?.()
    if (results?.[0]?.status === "fulfilled") await results[0].value.release()
    await secondLease?.release()
    await rm(dir, { recursive: true, force: true })
  }
})

test("simultaneous stale observers cannot both acquire the replacement lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-stale-observers-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const sentinel = await createV2LeaseDirectory(lock)
  const staleToken = "00000000-0000-4000-8000-000000000000"
  const staleClaimPath = join(
    persistenceLeaseInternals.claimDirectoryPathFor(lock),
    persistenceLeaseInternals.claimNameFor(staleToken),
  )
  await writeFile(staleClaimPath, JSON.stringify({
    protocol: 2,
    token: staleToken,
    pid: 2_147_483_647,
    hostname: hostname(),
    createdAt: 0,
  }))

  let beforeCount = 0
  let afterCount = 0
  let releaseBefore
  let releaseAfter
  let bothBefore
  let bothAfter
  const beforeBarrier = new Promise((resolve) => { releaseBefore = resolve })
  const afterBarrier = new Promise((resolve) => { releaseAfter = resolve })
  const bothAtBefore = new Promise((resolve) => { bothBefore = resolve })
  const bothAtAfter = new Promise((resolve) => { bothAfter = resolve })
  const hooks = {
    beforeOwnerWrite: async ({ attempt }) => {
      if (attempt !== 0) return
      beforeCount += 1
      if (beforeCount === 2) bothBefore()
      await beforeBarrier
    },
    afterOwnerWrite: async ({ attempt }) => {
      if (attempt !== 0) return
      afterCount += 1
      if (afterCount === 2) bothAfter()
      await afterBarrier
    },
  }

  let leases = []
  try {
    const first = persistenceLeaseInternals.acquirePersistenceLeaseWithHooks(state, {}, hooks)
    const second = persistenceLeaseInternals.acquirePersistenceLeaseWithHooks(state, {}, hooks)
    await bothAtBefore
    releaseBefore()
    await bothAtAfter
    releaseAfter()

    const results = await Promise.allSettled([first, second])
    leases = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value)
    assert.equal(leases.length, 1, "exactly one overlapping stale reclaimer must win")
    const rejected = results.find((result) => result.status === "rejected")
    assert.equal(isPersistenceLeaseContendedError(rejected?.reason), true)

    const mirror = JSON.parse(await readFile(lock, "utf8"))
    assert.deepEqual(mirror, sentinel)
    const claims = await claimNames(lock)
    assert.deepEqual(claims, [persistenceLeaseInternals.claimNameFor(leases[0].owner.token)])
  } finally {
    releaseBefore?.()
    releaseAfter?.()
    await Promise.allSettled(leases.map((lease) => lease.release()))
    await rm(dir, { recursive: true, force: true })
  }
})

test("concurrent release calls cannot delete a replacement lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-release-race-"))
  const state = join(dir, "state.json")
  let allowClaimRemoval
  let claimRemovalStarted
  const removalBarrier = new Promise((resolve) => { allowClaimRemoval = resolve })
  const atClaimRemoval = new Promise((resolve) => { claimRemovalStarted = resolve })
  let lease
  let replacement
  try {
    lease = await persistenceLeaseInternals.acquirePersistenceLeaseWithHooks(
      state,
      {},
      {
        beforeClaimRemove: async () => {
          claimRemovalStarted()
          await removalBarrier
        },
      },
    )
    const sentinelBefore = await readFile(`${state}.lock`, "utf8")
    const firstRelease = lease.release()
    await atClaimRemoval
    assert.equal(await lease.release(), false, "a second release must not enter teardown")
    allowClaimRemoval()
    assert.equal(await firstRelease, true)

    replacement = await acquirePersistenceLease(state)
    assert.equal(await readFile(`${state}.lock`, "utf8"), sentinelBefore)
    assert.deepEqual(await claimNames(`${state}.lock`), [
      persistenceLeaseInternals.claimNameFor(replacement.owner.token),
    ])
    assert.equal(await lease.release(), false)
    assert.equal(
      await readFile(`${state}.lock`, "utf8"),
      sentinelBefore,
    )
  } finally {
    allowClaimRemoval?.()
    await replacement?.release().catch(() => false)
    await lease?.release().catch(() => false)
    await rm(dir, { recursive: true, force: true })
  }
})

// Bounded like the child-process tests in session-concurrency.test.js. This test
// waits on a second Node process twice — for readiness, and for exit after the
// stop signal — and a mutant that stops the child ever reaching either point
// would otherwise wedge the whole run until the CI job's 15-minute timeout,
// reporting nothing about which mutant did it.
test("persistence lease prevents a second Node process from owning the same state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-process-"))
  const state = join(dir, "state.json")
  const moduleURL = new URL("../src/persistence-lease.js", import.meta.url).href
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquirePersistenceLease } from ${JSON.stringify(moduleURL)}
    const lease = await acquirePersistenceLease(${JSON.stringify(state)})
    process.stdout.write("READY\\n")
    process.stdin.once("data", async () => { await lease.release(); process.exit(0) })
  `], { stdio: ["pipe", "pipe", "pipe"] })
  // Reap the holder however this test ends. The `finally` below does not run
  // when the test times out, and a surviving child keeps its stdio pipes open —
  // which keeps the whole test runner process alive after the suite finishes.
  // A mutant that stops the child exiting therefore hangs the entire run rather
  // than failing one test.
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL")
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
  })
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  // The holder announces itself on stdout before the parent can meaningfully
  // contend for the lease. Race that against the child exiting: if it dies first
  // — a fail-closed acquire, an import error, anything — nothing will ever be
  // written, and waiting on stdout alone blocks forever. That is not
  // hypothetical: with the guard-completion mutant applied the child correctly
  // throws ERR_GOAL_PERSISTENCE_LEASE_PATH and exits, and this test used to hang
  // until the CI job's own timeout killed it, reporting nothing useful.
  const exitedEarly = once(child, "exit").then(([code, signal]) => {
    throw new Error(
      `lease holder exited before signalling READY (code ${code}, signal ${signal})` +
        (stderr ? `\nchild stderr:\n${stderr}` : ""),
    )
  })
  // The loop below may finish first and leave this rejection unobserved.
  exitedEarly.catch(() => {})
  try {
    let output = ""
    while (!output.includes("READY")) {
      const [chunk] = await Promise.race([once(child.stdout, "data"), exitedEarly])
      output += chunk.toString()
    }
    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(error.code, PERSISTENCE_LEASE_CONTENDED)
      assert.equal(isPersistenceLeaseContendedError(error), true)
      return true
    })
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

test("an aged token-matching future-protocol claim blocks and remains untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-future-claim-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const token = "00000000-0000-4000-8000-000000000003"
  const claimPath = join(
    persistenceLeaseInternals.claimDirectoryPathFor(lock),
    persistenceLeaseInternals.claimNameFor(token),
  )
  const futureClaim = JSON.stringify({
    protocol: 3,
    token,
    pid: process.pid,
    hostname: hostname(),
    createdAt: 0,
  })
  try {
    await createV2LeaseDirectory(lock)
    await writeFile(claimPath, futureClaim)
    await utimes(claimPath, new Date(0), new Date(0))
    const claimInfoBefore = await stat(claimPath)

    await assert.rejects(
      acquirePersistenceLease(state, { malformedGraceMs: 1, now: () => Date.now() }),
      (error) => {
        assert.equal(isPersistenceLeaseContendedError(error), true)
        assert.equal(error.reason, "owned_elsewhere")
        assert.deepEqual(error.owner, { pid: process.pid, hostname: hostname() })
        return true
      },
    )
    assert.equal(await readFile(claimPath, "utf8"), futureClaim)
    assert.equal((await stat(claimPath)).mtimeMs, claimInfoBefore.mtimeMs)
    assert.deepEqual(await claimNames(lock), [persistenceLeaseInternals.claimNameFor(token)])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a future-protocol claim remains authoritative even when its recorded process is dead", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-future-dead-claim-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const token = "00000000-0000-4000-8000-000000000004"
  const claimPath = join(
    persistenceLeaseInternals.claimDirectoryPathFor(lock),
    persistenceLeaseInternals.claimNameFor(token),
  )
  const futureClaim = JSON.stringify({
    protocol: 3,
    token,
    pid: 2_147_483_647,
    hostname: hostname(),
    createdAt: 0,
  })
  try {
    await createV2LeaseDirectory(lock)
    await writeFile(claimPath, futureClaim)
    await utimes(claimPath, new Date(0), new Date(0))

    await assert.rejects(
      acquirePersistenceLease(state, { malformedGraceMs: 1, now: () => Date.now() }),
      (error) => {
        assert.equal(isPersistenceLeaseContendedError(error), true)
        assert.equal(error.reason, "owned_elsewhere")
        return true
      },
    )
    assert.equal(await readFile(claimPath, "utf8"), futureClaim)
    assert.deepEqual(await claimNames(lock), [persistenceLeaseInternals.claimNameFor(token)])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("an unknown claim filename blocks conservatively and remains untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-future-claim-name-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const claimDirectory = persistenceLeaseInternals.claimDirectoryPathFor(lock)
  const claimPath = join(claimDirectory, "claim-next-owner.json")
  const futureClaim = JSON.stringify({
    protocol: 3,
    token: "next-owner",
    pid: process.pid,
    hostname: hostname(),
    createdAt: 0,
  })
  try {
    await createV2LeaseDirectory(lock)
    await writeFile(claimPath, futureClaim)
    await utimes(claimPath, new Date(0), new Date(0))

    await assert.rejects(acquirePersistenceLease(state, { malformedGraceMs: 1 }), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), true)
      assert.equal(error.reason, "owned_elsewhere")
      assert.deepEqual(error.owner, { pid: null, hostname: null })
      return true
    })
    assert.equal(await readFile(claimPath, "utf8"), futureClaim)
    assert.deepEqual(await readdir(claimDirectory), ["claim-next-owner.json"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease sanitizes hostile owner metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-hostile-owner-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const secretToken = "secret-token-that-must-not-leak"
  await mkdir(lock)
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({
      token: secretToken,
      pid: "123\n456",
      hostname: `evil-host\n${"x".repeat(300)}`,
      createdAt: 123,
      stateFilePath: "/private/secret/state.json",
    }),
  )
  try {
    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), true)
      assert.deepEqual(error.owner, { pid: null, hostname: null })
      assert.equal(error.reason, "legacy_lock")
      assert.doesNotMatch(error.message, /secret-token|private\/secret|evil-host|\n/)
      assert.deepEqual(Object.keys(error.owner).sort(), ["hostname", "pid"])
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease bounds oversized owner records before parsing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-oversized-owner-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const secret = "oversized-secret-".repeat(400)
  await mkdir(lock)
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({ token: secret, pid: process.pid, hostname: "valid.example" }),
  )
  try {
    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), true)
      assert.deepEqual(error.owner, { pid: null, hostname: null })
      assert.equal(error.reason, "legacy_lock")
      assert.doesNotMatch(error.message, /oversized-secret/)
      return true
    })
    await utimes(lock, new Date(0), new Date(0))
    await assert.rejects(acquirePersistenceLease(state, { malformedGraceMs: 1 }), (error) => {
      assert.equal(error.reason, "legacy_lock")
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease never follows a symlinked owner record", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is not reliably available on Windows CI")
    return
  }
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-owner-symlink-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const outside = join(dir, "outside-owner.json")
  const secret = "outside-secret-owner-token"
  await mkdir(lock)
  await writeFile(
    outside,
    JSON.stringify({ token: secret, pid: process.pid, hostname: "valid.example" }),
  )
  await symlink(outside, `${lock}/owner.json`)
  try {
    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), true)
      assert.deepEqual(error.owner, { pid: null, hostname: null })
      assert.equal(error.reason, "legacy_lock")
      assert.doesNotMatch(error.message, /outside-secret/)
      return true
    })
    await utimes(lock, new Date(0), new Date(0))
    await assert.rejects(acquirePersistenceLease(state, { malformedGraceMs: 1 }), (error) => {
      assert.equal(error.reason, "legacy_lock")
      return true
    })
    assert.match(await readFile(outside, "utf8"), /outside-secret-owner-token/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease rejects a symlinked lock directory without traversing it", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is not reliably available on Windows CI")
    return
  }
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-lock-symlink-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const outside = join(dir, "outside-lock")
  const ownerPath = join(outside, "owner.json")
  const secret = "outside-lock-secret-token"
  await mkdir(outside)
  await writeFile(
    ownerPath,
    JSON.stringify({ token: secret, pid: process.pid, hostname: "valid.example" }),
  )
  await symlink(outside, lock, "dir")
  try {
    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), false)
      assert.equal(error.code, "ERR_GOAL_PERSISTENCE_LEASE_PATH")
      assert.doesNotMatch(error.message, /outside-lock-secret/)
      return true
    })
    assert.match(await readFile(ownerPath, "utf8"), /outside-lock-secret-token/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease rejects a symlinked claim directory without traversing it", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is not reliably available on Windows CI")
    return
  }
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-claims-symlink-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  const claimDirectory = persistenceLeaseInternals.claimDirectoryPathFor(lock)
  const outside = join(dir, "outside-claims")
  const secretPath = join(outside, "secret.txt")
  try {
    await persistenceLeaseInternals.publishLegacyGuard(lock)
    await mkdir(outside)
    await writeFile(secretPath, "outside-claims-secret")
    await symlink(outside, claimDirectory, "dir")

    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), false)
      assert.equal(error.code, "ERR_GOAL_PERSISTENCE_LEASE_PATH")
      assert.doesNotMatch(error.message, /outside-claims-secret/)
      return true
    })
    assert.equal(await readFile(secretPath, "utf8"), "outside-claims-secret")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease treats a remote legacy owner as manual-recovery contention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-remote-owner-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  await mkdir(lock)
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({ token: "remote", pid: 4242, hostname: "remote.example" }),
  )
  try {
    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), true)
      assert.deepEqual(error.owner, { pid: 4242, hostname: "remote.example" })
      assert.equal(error.reason, "legacy_lock")
      return true
    })
    assert.equal(JSON.parse(await readFile(`${lock}/owner.json`, "utf8")).token, "remote")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the long-lived regular-file guard prevents version-1 stale reclamation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-v1-compatibility-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  try {
    const lease = await acquirePersistenceLease(state)
    const sentinelBefore = JSON.parse(await readFile(lock, "utf8"))
    const guardInfo = await stat(lock)

    assert.equal(persistenceLeaseInternals.validLegacySentinel(sentinelBefore), true)
    assert.equal(guardInfo.isFile(), true)
    assert.equal(persistenceLeaseInternals.legacyGuardMtimeIsSafe(guardInfo), true)
    await assert.rejects(acquireVersion1Lease(state), /version-1 lease contended/)

    assert.equal(await lease.release(), true)
    assert.deepEqual(
      JSON.parse(await readFile(lock, "utf8")),
      sentinelBefore,
    )
    assert.deepEqual(await claimNames(lock), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("persistence lease treats an invalid regular guard as manual-recovery contention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-lease-owner-io-"))
  const state = join(dir, "state.json")
  const lock = `${state}.lock`
  await writeFile(lock, "not a directory")
  try {
    await assert.rejects(acquirePersistenceLease(state), (error) => {
      assert.equal(isPersistenceLeaseContendedError(error), true)
      assert.equal(error.reason, "legacy_lock")
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
