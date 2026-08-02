import { randomUUID } from "node:crypto"
import { constants as fsConstants, promises as fs } from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"

export const PERSISTENCE_LEASE_CONTENDED = "GOAL_PERSISTENCE_LEASE_CONTENDED"
const LEASE_PROTOCOL_VERSION = 2
const LEGACY_SENTINEL_TOKEN = "opencode-goal-plugin-immutable-claims-v2"
const LEGACY_SENTINEL_HOSTNAME = "opencode-goal-plugin-v2.invalid"
const LEGACY_GUARD_MTIME_MS = Date.UTC(2100, 0, 1)
const LEGACY_GUARD_MTIME_TOLERANCE_MS = 2_000
const CLAIM_DIRECTORY_SUFFIX = ".claims-v2"
const CLAIM_PREFIX = "claim-"
const CLAIM_SUFFIX = ".json"
const MAX_OWNER_FILE_BYTES = 4 * 1024
const MAX_OWNER_TOKEN_LENGTH = 256
const MAX_OWNER_HOSTNAME_LENGTH = 255
const MAX_ACQUIRE_ATTEMPTS = 5

function validStoredHostname(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_OWNER_HOSTNAME_LENGTH
  )
}

function validDisplayHostname(value) {
  return validStoredHostname(value) && /^[A-Za-z0-9._-]+$/.test(value)
}

function validOwner(owner) {
  return (
    owner !== null &&
    typeof owner === "object" &&
    !Array.isArray(owner) &&
    typeof owner.token === "string" &&
    owner.token.length >= 1 &&
    owner.token.length <= MAX_OWNER_TOKEN_LENGTH &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    validStoredHostname(owner.hostname)
  )
}

function sanitizeOwner(owner) {
  const pid = Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? owner.pid : null
  const hostname = validDisplayHostname(owner?.hostname) ? owner.hostname : null
  return Object.freeze({ pid, hostname })
}

function describeOwner(owner) {
  return owner?.pid && owner?.hostname
    ? `pid ${owner.pid} on ${owner.hostname}`
    : "an unknown owner"
}

export class PersistenceLeaseContendedError extends Error {
  constructor(owner, reason = "owned_elsewhere") {
    const safeOwner = sanitizeOwner(owner)
    const safeReason = reason === "legacy_lock" ? "legacy_lock" : "owned_elsewhere"
    super(safeReason === "legacy_lock"
      ? "goal persistence uses a legacy or incomplete lease; close every OpenCode instance using this session, then remove its lease artifacts before retrying"
      : `goal persistence is already owned by ${describeOwner(safeOwner)}; close the other OpenCode instance or open a fork`)
    this.name = "PersistenceLeaseContendedError"
    this.code = PERSISTENCE_LEASE_CONTENDED
    this.owner = safeOwner
    this.reason = safeReason
  }
}

export function isPersistenceLeaseContendedError(error) {
  return error instanceof PersistenceLeaseContendedError
}

function persistenceLeasePathError() {
  const error = new Error("goal persistence lease paths must use their expected real file types")
  error.code = "ERR_GOAL_PERSISTENCE_LEASE_PATH"
  return error
}

function persistenceLeaseHardLinkError() {
  const error = new Error(
    "goal persistence requires same-filesystem hard-link support for its compatibility guard",
  )
  error.code = "ERR_GOAL_PERSISTENCE_LEASE_HARDLINK"
  return error
}

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

async function assertLockDirectory(lockPath) {
  let lockInfo
  try {
    lockInfo = await fs.lstat(lockPath)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) {
    throw persistenceLeasePathError()
  }
  return lockInfo
}

async function readBoundedOwnerFile(handle, expectedInfo) {
  const buffer = Buffer.alloc(MAX_OWNER_FILE_BYTES + 1)
  let bytesReadTotal = 0
  while (bytesReadTotal < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      bytesReadTotal,
      buffer.length - bytesReadTotal,
      bytesReadTotal,
    )
    if (bytesRead === 0) break
    bytesReadTotal += bytesRead
  }

  const finalInfo = await handle.stat()
  if (
    !finalInfo.isFile() ||
    bytesReadTotal === 0 ||
    bytesReadTotal > MAX_OWNER_FILE_BYTES ||
    bytesReadTotal !== expectedInfo.size ||
    finalInfo.size !== expectedInfo.size ||
    finalInfo.dev !== expectedInfo.dev ||
    finalInfo.ino !== expectedInfo.ino
  ) {
    return null
  }
  return buffer.toString("utf8", 0, bytesReadTotal)
}

async function readOwnerRecord(ownerPath) {
  let ownerInfo
  try {
    ownerInfo = await fs.lstat(ownerPath)
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", owner: null, info: null }
    throw error
  }
  if (
    ownerInfo.isSymbolicLink() ||
    !ownerInfo.isFile() ||
    ownerInfo.size === 0 ||
    ownerInfo.size > MAX_OWNER_FILE_BYTES
  ) {
    return { status: "malformed", owner: null, info: ownerInfo }
  }

  let handle
  try {
    const flags =
      fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0)
    handle = await fs.open(ownerPath, flags)
    const openedInfo = await handle.stat()
    if (
      !openedInfo.isFile() ||
      openedInfo.size === 0 ||
      openedInfo.size > MAX_OWNER_FILE_BYTES ||
      openedInfo.dev !== ownerInfo.dev ||
      openedInfo.ino !== ownerInfo.ino
    ) {
      return { status: "malformed", owner: null, info: ownerInfo }
    }

    const raw = await readBoundedOwnerFile(handle, openedInfo)
    if (raw === null) return { status: "malformed", owner: null, info: ownerInfo }
    const parsed = JSON.parse(raw)
    return validOwner(parsed)
      ? { status: "valid", owner: parsed, info: ownerInfo }
      : { status: "malformed", owner: null, info: ownerInfo }
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === "ENOENT" || error?.code === "ELOOP") {
      return { status: "malformed", owner: null, info: ownerInfo }
    }
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function readOwner(lockPath) {
  let lockInfo
  try {
    lockInfo = await fs.lstat(lockPath)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  if (lockInfo.isSymbolicLink()) throw persistenceLeasePathError()
  const ownerPath = lockInfo.isDirectory()
    ? join(lockPath, "owner.json")
    : lockInfo.isFile()
      ? lockPath
      : null
  if (!ownerPath) throw persistenceLeasePathError()
  const record = await readOwnerRecord(ownerPath)
  return record.status === "valid" ? record.owner : null
}

function ownerIsBlocking(owner, localHostname) {
  if (owner.hostname !== localHostname) return true
  return processIsAlive(owner.pid) !== false
}

function claimNameFor(token) {
  return `${CLAIM_PREFIX}${token}${CLAIM_SUFFIX}`
}

function isClaimLikeName(name) {
  return name.startsWith(CLAIM_PREFIX) && name.endsWith(CLAIM_SUFFIX)
}

function tokenFromClaimName(name) {
  if (!isClaimLikeName(name)) return null
  const token = name.slice(CLAIM_PREFIX.length, -CLAIM_SUFFIX.length)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
    ? token
    : null
}

async function writeAtomicJSON(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value), { mode: 0o600, flag: "wx" })
    await fs.rename(temporaryPath, path)
  } finally {
    await fs.unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error
    })
  }
}

function legacySentinel() {
  return {
    protocol: LEASE_PROTOCOL_VERSION,
    sentinel: true,
    token: LEGACY_SENTINEL_TOKEN,
    pid: 1,
    hostname: LEGACY_SENTINEL_HOSTNAME,
    createdAt: Date.now(),
  }
}

function validLegacySentinel(owner) {
  return (
    validOwner(owner) &&
    Object.keys(owner).sort().join(",") ===
      "createdAt,hostname,pid,protocol,sentinel,token" &&
    owner.protocol === LEASE_PROTOCOL_VERSION &&
    owner.sentinel === true &&
    owner.token === LEGACY_SENTINEL_TOKEN &&
    owner.pid === 1 &&
    owner.hostname === LEGACY_SENTINEL_HOSTNAME &&
    Number.isFinite(owner.createdAt) &&
    owner.createdAt >= 0
  )
}

function legacyGuardMtimeIsSafe(info) {
  return (
    Number.isFinite(info?.mtimeMs) &&
    info.mtimeMs >= LEGACY_GUARD_MTIME_MS - LEGACY_GUARD_MTIME_TOLERANCE_MS
  )
}

function claimDirectoryPathFor(lockPath) {
  return `${lockPath}${CLAIM_DIRECTORY_SUFFIX}`
}

async function inspectLegacyGuard(lockPath) {
  let info
  try {
    info = await fs.lstat(lockPath)
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", owner: null, info: null }
    throw error
  }
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw persistenceLeasePathError()
  }
  if (info.isDirectory()) {
    const legacy = await readOwnerRecord(join(lockPath, "owner.json"))
    return { status: "legacy", owner: legacy.owner, info }
  }

  const record = await readOwnerRecord(lockPath)
  if (
    record.status === "valid" &&
    validLegacySentinel(record.owner) &&
    legacyGuardMtimeIsSafe(record.info)
  ) {
    return { status: "valid", owner: record.owner, info: record.info }
  }
  return { status: "incomplete", owner: record.owner, info: record.info }
}

function throwForGuardStatus(guard) {
  if (guard.status === "valid" || guard.status === "missing") return
  throw new PersistenceLeaseContendedError(guard.owner, "legacy_lock")
}

function hardLinkUnsupported(error) {
  return ["EPERM", "EOPNOTSUPP", "ENOTSUP", "EXDEV"].includes(error?.code)
}

async function publishLegacyGuard(
  lockPath,
  { beforeGuardLink, afterGuardLink, linkGuard = (source, target) => fs.link(source, target) } = {},
) {
  const temporaryPath = `${lockPath}.guard.${process.pid}.${randomUUID()}.tmp`
  const sentinel = legacySentinel()
  let handle
  let preparedInfo
  let linked = false
  try {
    handle = await fs.open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    await handle.writeFile(JSON.stringify(sentinel))
    await handle.sync()
    const guardDate = new Date(LEGACY_GUARD_MTIME_MS)
    await handle.utimes(guardDate, guardDate)
    await handle.sync()
    preparedInfo = await handle.stat()
    if (!preparedInfo.isFile() || !legacyGuardMtimeIsSafe(preparedInfo)) {
      throw persistenceLeasePathError()
    }
    await handle.close()
    handle = null

    await beforeGuardLink?.({ lockPath, temporaryPath, sentinel: { ...sentinel } })
    try {
      await linkGuard(temporaryPath, lockPath)
      linked = true
    } catch (error) {
      const racedGuard = await inspectLegacyGuard(lockPath)
      if (racedGuard.status !== "missing") {
        throwForGuardStatus(racedGuard)
        return racedGuard
      }
      if (error?.code === "EEXIST") return null
      if (hardLinkUnsupported(error)) throw persistenceLeaseHardLinkError()
      throw error
    }
    await afterGuardLink?.({ lockPath, temporaryPath, sentinel: { ...sentinel } })

    const guard = await inspectLegacyGuard(lockPath)
    if (guard.status === "missing") return null
    throwForGuardStatus(guard)
    if (
      !linked ||
      guard.info.dev !== preparedInfo.dev ||
      guard.info.ino !== preparedInfo.ino
    ) {
      throw persistenceLeasePathError()
    }
    return guard
  } finally {
    await handle?.close().catch(() => {})
    await fs.unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error
    })
  }
}

async function ensureLegacyGuard(lockPath, hooks = {}) {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const guard = await inspectLegacyGuard(lockPath)
    if (guard.status === "valid") return guard
    if (guard.status !== "missing") {
      throwForGuardStatus(guard)
    }
    const published = await publishLegacyGuard(lockPath, hooks)
    if (published) return published
    await retryDelay(randomUUID(), attempt)
  }
  throw new PersistenceLeaseContendedError(null)
}

async function ensureClaimDirectory(claimDirectoryPath) {
  try {
    await fs.mkdir(claimDirectoryPath, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }
  return assertLockDirectory(claimDirectoryPath)
}

async function removeUniqueClaim(claimPath) {
  try {
    await fs.unlink(claimPath)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

async function inspectClaims(
  lockPath,
  ownToken,
  localHostname,
  { malformedGraceMs, now },
) {
  const entries = await fs.readdir(lockPath, { withFileTypes: true })
  let ownFound = false
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const expectedToken = tokenFromClaimName(entry.name)
    if (!expectedToken) {
      if (isClaimLikeName(entry.name)) {
        return { blocker: null, blocked: true, ownFound }
      }
      continue
    }
    const claimPath = join(lockPath, entry.name)
    const record = await readOwnerRecord(claimPath)
    if (record.status === "missing") continue

    const structurallyValidClaim =
      record.status === "valid" &&
      record.owner.token === expectedToken
    if (!structurallyValidClaim) {
      const age = record.info ? now() - record.info.mtimeMs : 0
      if (age < malformedGraceMs) {
        return { blocker: null, blocked: true, ownFound }
      }
      await removeUniqueClaim(claimPath)
      continue
    }

    // A token-matching claim from an unknown protocol is authoritative to that
    // protocol. Never infer that it is stale or safe to remove.
    if (record.owner.protocol !== LEASE_PROTOCOL_VERSION) {
      return { blocker: record.owner, blocked: true, ownFound }
    }

    if (record.owner.token === ownToken) {
      ownFound = true
      continue
    }
    if (ownerIsBlocking(record.owner, localHostname)) {
      return { blocker: record.owner, blocked: true, ownFound }
    }
    await removeUniqueClaim(claimPath)
  }
  return { blocker: null, blocked: false, ownFound }
}

function retryDelay(token, attempt) {
  const offset = Number.parseInt(token.slice(attempt * 2, attempt * 2 + 2), 16) || 0
  return new Promise((resolve) => setTimeout(resolve, 1 + (offset % 7)))
}

function createLease(
  lockPath,
  claimDirectoryPath,
  claimPath,
  owner,
  { beforeClaimRemove } = {},
) {
  let releasing = false
  let released = false
  return {
    lockPath,
    claimDirectoryPath,
    owner,
    async release() {
      if (released || releasing) return false
      releasing = true
      try {
        const claim = await readOwnerRecord(claimPath)
        if (claim.status === "missing") {
          released = true
          return false
        }
        if (claim.status !== "valid" || claim.owner.token !== owner.token) return false

        await beforeClaimRemove?.({
          lockPath,
          claimDirectoryPath,
          claimPath,
          owner: { ...owner },
        })
        const removed = await removeUniqueClaim(claimPath)
        if (removed) released = true
        return removed
      } finally {
        releasing = false
      }
    },
  }
}

/**
 * Hold an exclusive session lease for the plugin instance lifetime.
 *
 * Version 2 atomically publishes a long-lived regular-file guard at the legacy
 * `.lock` path. Its far-future mtime makes version-1's malformed-directory
 * recovery fail closed, while hard-link publication ensures the legacy path is
 * never visible partially initialized. Version-2 peers elect ownership from
 * never-reused UUID claims in a stable sibling directory. Stale cleanup and
 * release therefore unlink only an immutable claim; neither operation can
 * delete a newer owner's lease after a delayed filesystem call.
 */
async function acquirePersistenceLeaseWithHooks(
  stateFilePath,
  { malformedGraceMs = 30_000, now = () => Date.now() } = {},
  hooks = {},
) {
  const {
    beforeGuardLink,
    afterGuardLink,
    linkGuard,
    beforeOwnerWrite,
    afterOwnerWrite,
    beforeClaimRemove,
  } = hooks
  const lockPath = `${stateFilePath}.lock`
  const claimDirectoryPath = claimDirectoryPathFor(lockPath)
  const localHostname = hostname()
  await fs.mkdir(dirname(stateFilePath), { recursive: true, mode: 0o700 })
  let lastBlocker = null

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    await ensureLegacyGuard(lockPath, { beforeGuardLink, afterGuardLink, linkGuard })
    if (!(await ensureClaimDirectory(claimDirectoryPath))) {
      continue
    }

    const existing = await inspectClaims(
      claimDirectoryPath,
      null,
      localHostname,
      { malformedGraceMs, now },
    )
    if (existing.blocked) throw new PersistenceLeaseContendedError(existing.blocker)
    const owner = {
      protocol: LEASE_PROTOCOL_VERSION,
      token: randomUUID(),
      pid: process.pid,
      hostname: localHostname,
      createdAt: Date.now(),
    }
    const claimPath = join(claimDirectoryPath, claimNameFor(owner.token))
    let claimPublished = false
    try {
      await beforeOwnerWrite?.({
        lockPath,
        claimDirectoryPath,
        claimPath,
        owner: { ...owner },
        attempt,
      })
      await writeAtomicJSON(claimPath, owner)
      claimPublished = true
      await afterOwnerWrite?.({
        lockPath,
        claimDirectoryPath,
        claimPath,
        owner: { ...owner },
        attempt,
      })

      const observed = await inspectClaims(
        claimDirectoryPath,
        owner.token,
        localHostname,
        { malformedGraceMs, now },
      )
      if (!observed.ownFound || observed.blocked) {
        lastBlocker = observed.blocker
        await removeUniqueClaim(claimPath)
        claimPublished = false
        await retryDelay(owner.token, attempt)
        continue
      }

      await ensureLegacyGuard(lockPath, { beforeGuardLink, afterGuardLink, linkGuard })
      return createLease(
        lockPath,
        claimDirectoryPath,
        claimPath,
        owner,
        { beforeClaimRemove },
      )
    } catch (error) {
      if (claimPublished) await removeUniqueClaim(claimPath).catch(() => false)
      if (error?.code === "ENOENT") continue
      throw error
    }
  }
  throw new PersistenceLeaseContendedError(lastBlocker)
}

export async function acquirePersistenceLease(stateFilePath, options = {}) {
  return acquirePersistenceLeaseWithHooks(stateFilePath, options)
}

export const persistenceLeaseInternals = Object.freeze({
  acquirePersistenceLeaseWithHooks,
  claimDirectoryPathFor,
  claimNameFor,
  inspectLegacyGuard,
  inspectClaims,
  legacyGuardMtimeIsSafe,
  legacySentinel,
  publishLegacyGuard,
  processIsAlive,
  readBoundedOwnerFile,
  readOwner,
  readOwnerRecord,
  sanitizeOwner,
  validLegacySentinel,
  validDisplayHostname,
  validOwner,
  validStoredHostname,
})
