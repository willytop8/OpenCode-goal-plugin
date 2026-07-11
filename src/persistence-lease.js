import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { hostname } from "node:os"
import { dirname } from "node:path"

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    return true
  }
}

async function readOwner(lockPath) {
  try {
    return JSON.parse(await fs.readFile(`${lockPath}/owner.json`, "utf8"))
  } catch {
    return null
  }
}

/**
 * Hold an exclusive workspace lease for the plugin instance lifetime. This
 * deliberately rejects a second writer instead of allowing stale full-state
 * snapshots to overwrite each other.
 */
export async function acquirePersistenceLease(
  stateFilePath,
  { malformedGraceMs = 30_000, now = () => Date.now() } = {},
) {
  const lockPath = `${stateFilePath}.lock`
  await fs.mkdir(dirname(stateFilePath), { recursive: true, mode: 0o700 })
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 })
      await fs.writeFile(`${lockPath}/owner.json`, JSON.stringify(owner), { mode: 0o600 })
      return {
        lockPath,
        owner,
        async release() {
          const current = await readOwner(lockPath)
          if (current?.token !== owner.token) return false
          await fs.rm(lockPath, { recursive: true, force: true })
          return true
        },
      }
    } catch (error) {
      if (error?.code !== "EEXIST") {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      const existing = await readOwner(lockPath)
      const sameHost = existing?.hostname === owner.hostname
      let reclaimableMalformed = false
      if (!existing) {
        try {
          const info = await fs.lstat(lockPath)
          reclaimableMalformed = now() - info.mtimeMs >= malformedGraceMs
        } catch (statError) {
          if (statError?.code === "ENOENT") continue
        }
      }
      if ((sameHost && processIsAlive(existing?.pid) === false) || reclaimableMalformed) {
        const stalePath = `${lockPath}.stale.${randomUUID()}`
        try {
          await fs.rename(lockPath, stalePath)
          await fs.rm(stalePath, { recursive: true, force: true })
          continue
        } catch (reclaimError) {
          if (reclaimError?.code === "ENOENT") continue
        }
      }
      const description = existing
        ? `pid ${existing.pid} on ${existing.hostname}`
        : "an unknown owner"
      throw new Error(
        `goal persistence is already owned by ${description}; close the other OpenCode instance or configure a different stateFilePath`,
      )
    }
  }
  throw new Error("could not acquire goal persistence lease")
}

export const persistenceLeaseInternals = Object.freeze({ processIsAlive, readOwner })
