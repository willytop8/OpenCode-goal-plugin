import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("..", import.meta.url))
const root = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-mutations-"))

function matchCheckoutNewlines(value, source) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n"
  return value.replace(/\r?\n/g, newline)
}

// An anchor may be a literal string or a RegExp, and `to` may be a replacement
// string or a function receiving the match.
//
// Prefer a RegExp whenever the anchored line carries a value that legitimately
// grows — a set's members, a list of names, an enumeration. A literal anchor
// pins that value, so the next honest edit to it silently detaches the mutant
// and the contract fails as if a safety property had broken. Anchor on the
// declaration and mutate relative to the match instead.
//
// Literal anchors remain right for pinned *logic* — a comparison, a call, an
// assignment — where a change to the line genuinely should force someone to
// re-examine whether the mutant still expresses the property under test.
//
// RegExp anchors are matched against the file as checked out, so keep them to a
// single line; a literal anchor spanning lines is normalised for CRLF, a RegExp
// is not.
function locateMutation(mutant, original) {
  if (mutant.from instanceof RegExp) {
    const flags = mutant.from.flags.includes("g")
      ? mutant.from.flags
      : `${mutant.from.flags}g`
    const pattern = new RegExp(mutant.from.source, flags)
    return {
      occurrences: [...original.matchAll(pattern)].length,
      mutate: () => original.replace(pattern, mutant.to),
    }
  }
  const from = matchCheckoutNewlines(mutant.from, original)
  const to =
    typeof mutant.to === "function" ? mutant.to : matchCheckoutNewlines(mutant.to, original)
  return {
    occurrences: original.split(from).length - 1,
    mutate: () => original.replace(from, to),
  }
}

function staleAnchorMessage(mutant, occurrences) {
  if (occurrences === 0) {
    return (
      `${mutant.name}: mutation anchor no longer matches anything in ${mutant.file}.\n` +
      `This is a stale anchor, not a failed safety property: the source moved on and the\n` +
      `mutant no longer points at it. Update this mutant in scripts/mutation-contract.mjs to\n` +
      `match the current source. Note the property it guards is UNVERIFIED until you do.\n` +
      `If the anchored value is one that legitimately changes over time, re-anchor it on the\n` +
      `surrounding declaration with a RegExp so the next edit does not detach it again.`
    )
  }
  return (
    `${mutant.name}: mutation anchor matches ${mutant.file} ${occurrences} times and must\n` +
    `match exactly once. Tighten the anchor in scripts/mutation-contract.mjs so it selects a\n` +
    `single site — mutating several at once does not prove which one the test caught.`
  )
}

const mutants = [
  {
    name: "verifier default deny",
    file: "src/native-agent-config.js",
    from: '\"*\": \"deny\"',
    to: '\"*\": \"allow\"',
    test: "test/native-agent-config.test.js",
  },
  {
    name: "mutating SDK calls are never replayed",
    file: "src/opencode-session-api.js",
    // Anchored on the declaration, not its members: the replay-safe set grows
    // whenever a read-only operation is added, and a literal anchor detaches
    // every time it does. Adding a mutating operation must stay caught.
    from: /const REPLAY_SAFE_OPERATIONS = new Set\(\[[^\]]*\]\)/,
    to: (match) => match.replace(/\]\)$/, ', "prompt"])'),
    test: "test/opencode-session-api.test.js",
  },
  {
    name: "completion evidence must be adjacent",
    file: "src/goal-plugin.js",
    from: "const previous = markerIndex - 1",
    to: "const previous = markerIndex - 2",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "terminal completion requires durable storage",
    file: "src/goal-plugin.js",
    from: 'const durable = await persistFinal(sessionID, "completion", ledgerDurable)\n        if (durable === false) {',
    to: 'const durable = await persistFinal(sessionID, "completion", ledgerDurable)\n        if (false) {',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "terminal rollback detects same-session mutation without cross-session coupling",
    file: "src/goal-plugin.js",
    from: "if ((sessionMutationVersions.get(sessionID) || 0) !== snapshot?.mutationVersion) return false",
    to: "if (false) return false",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "token accounting resets only after compaction succeeds",
    file: "src/goal-plugin.js",
    from: 'event?.type === \"session.compacted\"',
    to: 'event?.type === \"session.compacting\"',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "command output mutates the host-retained parts array",
    file: "src/goal-plugin.js",
    from: "currentParts.splice(0, currentParts.length, ...nextParts)",
    to: "output.parts = nextParts",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "command results carry plugin provenance",
    file: "src/goal-plugin.js",
    from: '"opencode-goal-plugin": { kind: "command", id: commandID },',
    to: '"opencode-goal-plugin": { kind: "human", id: commandID },',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "command provenance requires a pending runtime correlation",
    file: "src/goal-plugin.js",
    from: "const commandTurn = consumePendingCommandTurn(sessionID, message)",
    to: 'const commandTurn = pluginMessageCorrelationID(message, "command") ? { id: pluginMessageCorrelationID(message, "command"), policy: "work" } : null',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "handled command errors default to a control boundary",
    file: "src/goal-plugin.js",
    from: 'commandTurn.policy = startsWork ? "work" : "control"',
    to: 'commandTurn.policy = "work"',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "control command results carry direct reporting instructions",
    file: "src/goal-plugin.js",
    from: "const routedText = startsWork ? String(text) : frameControlCommandText(text)",
    to: "const routedText = String(text)",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "control command data cannot break its reporting frame",
    file: "src/goal-plugin.js",
    from: "    escapeGoalText(text),\n    \"</goal_command_result>\",",
    to: "    String(text),\n    \"</goal_command_result>\",",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "resolved attachment companions require a retained input file",
    file: "src/goal-plugin.js",
    from: "turn?.preservedFileCount > 0",
    to: "true",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "retained attachments accept OpenCode's resolved companions",
    file: "src/goal-plugin.js",
    from: "turn?.preservedFileCount > 0",
    to: "false",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "each retained attachment yields at least one resolved companion",
    file: "src/goal-plugin.js",
    from: "companionParts.length >= turn.preservedFileCount",
    to: "companionParts.length >= 0",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "attachment failures become read-only control turns",
    file: "src/goal-plugin.js",
    from: 'resolvingCommandTurn.policy = "control"',
    to: 'resolvingCommandTurn.policy = "work"',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "attachment failures refresh expired command correlations",
    file: "src/goal-plugin.js",
    from: "resolvingCommandTurn.createdAt = Date.now()",
    to: "resolvingCommandTurn.createdAt = resolvingCommandTurn.createdAt",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "control turns block every tool call",
    file: "src/goal-plugin.js",
    from: 'if (currentRuntime().activeCommandTurns.get(sessionID)?.policy !== "control") return',
    to: 'if (currentRuntime().activeCommandTurns.get(sessionID)?.policy !== "control" || input?.tool === "read") return',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "resolved command parts remain bound to one host message",
    file: "src/goal-plugin.js",
    from: "const partsBelongToResolvedMessage =\n    Boolean(resolvedMessageID) &&\n    resolvedSessionID === sessionID &&\n    messageParts.every(\n      (candidate) =>\n        candidate?.messageID === resolvedMessageID && candidate?.sessionID === sessionID,\n    )",
    to: "const partsBelongToResolvedMessage = true",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "resolved attachment companions cannot carry plugin metadata",
    file: "src/goal-plugin.js",
    from: '!part?.metadata?.["opencode-goal-plugin"] &&',
    to: "true &&",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "control responses are excluded from terminal analysis",
    file: "src/goal-plugin.js",
    from: "currentRuntime().suppressedCommandAssistants.get(latestAssistantID) === sessionID ||",
    to: "false ||",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "control responses do not advance progress timestamps",
    file: "src/goal-plugin.js",
    from: '    parentOwner?.policy === "control" &&\n',
    to: "    false &&\n",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "command boundaries match their assistant parent",
    file: "src/goal-plugin.js",
    from: "messageParentID(commandAssistant) !== activeCommandTurn.messageID",
    to: "false",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "only typed lease contention enters passive mode",
    file: "src/persistence-lease.js",
    from: "return error instanceof PersistenceLeaseContendedError",
    to: "return true",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "stored owner hostnames are validated separately from diagnostics",
    file: "src/persistence-lease.js",
    from: "    validStoredHostname(owner.hostname)",
    to: "    validDisplayHostname(owner.hostname)",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "bounded owner records tolerate legal short reads",
    file: "src/persistence-lease.js",
    from: "  while (bytesReadTotal < buffer.length) {",
    to: "  if (bytesReadTotal < buffer.length) {",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "overlapping immutable lease claimants cannot both win",
    file: "src/persistence-lease.js",
    from: "      if (!observed.ownFound || observed.blocked) {",
    to: "      if (false) {",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "compatibility guard publication is atomic and no-replace",
    file: "src/persistence-lease.js",
    from: "      await linkGuard(temporaryPath, lockPath)",
    to: "      await fs.rename(temporaryPath, lockPath)",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "compatibility guards are complete before publication",
    file: "src/persistence-lease.js",
    from: "    await handle.utimes(guardDate, guardDate)",
    to: "    await Promise.resolve()",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "compatibility guards require the exact sentinel schema",
    file: "src/persistence-lease.js",
    from: '    Object.keys(owner).sort().join(",") ===\n      "createdAt,hostname,pid,protocol,sentinel,token" &&',
    to: "    true &&",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "vanished version-1 guards retry after publication contention",
    file: "src/persistence-lease.js",
    from: '      if (error?.code === "EEXIST") return null',
    to: "      if (false) return null",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "ownership is returned only while the compatibility guard exists",
    file: "src/persistence-lease.js",
    from: "      await ensureLegacyGuard(lockPath, { beforeGuardLink, afterGuardLink, linkGuard })\n      return createLease(",
    to: "      await Promise.resolve()\n      return createLease(",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "unsupported hard-link filesystems fail closed",
    file: "src/persistence-lease.js",
    from: "      if (hardLinkUnsupported(error)) throw persistenceLeaseHardLinkError()",
    to: "      if (false) throw persistenceLeaseHardLinkError()",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "unknown future claim filenames block conservatively",
    file: "src/persistence-lease.js",
    from: "      if (isClaimLikeName(entry.name)) {",
    to: "      if (false) {",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "future lease protocols block conservatively",
    file: "src/persistence-lease.js",
    from: "    if (record.owner.protocol !== LEASE_PROTOCOL_VERSION) {",
    to: "    if (false) {",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "lease release teardown is single-entry",
    file: "src/persistence-lease.js",
    from: "      if (released || releasing) return false",
    to: "      if (released) return false",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "disposed instances do not perform delayed legacy migration",
    file: "src/goal-plugin.js",
    from: "    try {\n      if (currentRuntime().disposed) return\n      if (await pathExists(persistenceOptions.migrationMarkerPath)) return",
    to: "    try {\n      if (false) return\n      if (await pathExists(persistenceOptions.migrationMarkerPath)) return",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "fresh migration markers require aggregate lease ownership",
    file: "src/goal-plugin.js",
    from: "  const freshMigrationLease = await acquireMigrationLease(\n    persistenceOptions.stateFilePath,\n    persistenceOptions.migrationMarkerPath,\n  )",
    to: "  const freshMigrationLease = { release: async () => false }",
    test: "test/session-concurrency.test.js",
  },
  {
    name: "fresh migration marker leases are released",
    file: "src/goal-plugin.js",
    from: "    await freshMigrationLease.release()",
    to: "    await Promise.resolve()",
    test: "test/session-concurrency.test.js",
  },
  {
    name: "disposed command continuations cannot mutate state",
    file: "src/goal-plugin.js",
    from: "      const loadResult = await ensureSessionLoaded(sessionID, {\n        retryPassive: true,\n        freshCommandBoundary: true,\n      })\n      if (currentRuntime().disposed || loadResult.kind === \"disposed\") return\n      const commandTurn = registerPendingCommandTurn(sessionID, output)",
    to: "      const loadResult = await ensureSessionLoaded(sessionID, {\n        retryPassive: true,\n        freshCommandBoundary: true,\n      })\n      if (loadResult.kind === \"disposed\") return\n      const commandTurn = registerPendingCommandTurn(sessionID, output)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "disposed tool continuations cannot invoke handlers",
    file: "src/goal-plugin.js",
    from: '  if (disposed || loadResult?.kind === "disposed") {',
    to: '  if (loadResult?.kind === "disposed") {',
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "session storage failures remain fatal",
    file: "src/goal-plugin.js",
    from: "      } catch (error) {\n        if (!isPersistenceLeaseContendedError(error)) throw error\n        return enterPassiveSession(sessionID, error)\n      }",
    to: "      } catch (error) {\n        if (false) throw error\n        return enterPassiveSession(sessionID, error)\n      }",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "overlapping hooks await one complete session load",
    file: "src/goal-plugin.js",
    from: "    const existingLoad = runtime.sessionLoadPromises.get(sessionID)\n    if (existingLoad) return existingLoad\n    if (runtime.sessionPersistence.has(sessionID)) return ACTIVE_PERSISTENCE_OWNED",
    to: "    if (runtime.sessionPersistence.has(sessionID)) return ACTIVE_PERSISTENCE_OWNED\n    const existingLoad = runtime.sessionLoadPromises.get(sessionID)\n    if (existingLoad) return existingLoad",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "passive load results cannot masquerade as active",
    file: "src/goal-plugin.js",
    from: "  const passiveLoadResult = (entry) => ({\n    kind: \"passive\",\n    code: SESSION_OWNED_ELSEWHERE,",
    to: "  const passiveLoadResult = (entry) => ({\n    kind: \"active\",\n    code: SESSION_OWNED_ELSEWHERE,",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "legacy lease recovery reason reaches passive controls",
    file: "src/goal-plugin.js",
    from: "    reason: entry.reason,",
    to: '    reason: "owned_elsewhere",',
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "host logging never retains a persistence lease",
    file: "src/goal-plugin.js",
    from: "    void Promise.resolve(call()).catch(onFailure)",
    to: "    return Promise.resolve(call()).catch(onFailure)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "disposed idle lookups cannot repopulate command state",
    file: "src/goal-plugin.js",
    from: "    if (runtime.disposed) return { ready: false, messages: null }\n    const commandMessages = Array.isArray(commandHostMessages)\n      ? commandHostMessages.slice(-messageLimit)\n      : []\n    if (runtime.activeCommandTurns.get(sessionID) !== activeCommandTurn) {",
    to: "    if (false) return { ready: false, messages: null }\n    const commandMessages = Array.isArray(commandHostMessages)\n      ? commandHostMessages.slice(-messageLimit)\n      : []\n    if (false) {",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "a delayed idle lookup cannot retire a newer command guard",
    file: "src/goal-plugin.js",
    from: "    if (runtime.activeCommandTurns.get(sessionID) !== activeCommandTurn) {",
    to: "    if (false) {",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive command guards survive stale idle events",
    file: "src/goal-plugin.js",
    from: "          await retireCompletedCommandTurnOnIdle(\n            eventSessionID,\n            defaultGoalOptions.maxRecentMessages,\n          )",
    to: "          currentRuntime().activeCommandTurns.delete(eventSessionID)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "takeover preserves the observed execution context",
    file: "src/goal-plugin.js",
    from: "  if (!preserveExecutionContext) runtime.sessionExecutionContexts.delete(sessionID)",
    to: "  runtime.sessionExecutionContexts.delete(sessionID)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "partial tool context preserves model and variant",
    file: "src/goal-plugin.js",
    from: "  const merged = {\n    ...previous,\n    ...observed,",
    to: "  const merged = {\n    ...observed,",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "authoritative host context clears stale variants",
    file: "src/goal-plugin.js",
    from: "      rememberSessionExecutionContext(sessionID, input, { replace: true })",
    to: "      rememberSessionExecutionContext(sessionID, input)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "canonical tools contribute their execution context",
    file: "src/goal-plugin.js",
    from: "      executionContext: ctx,\n    })\n    const unavailable = inactiveGoalToolResult(\n      loadResult,\n      commandName,\n      isDisposed(),\n      commandRegistered,\n    )\n    if (unavailable) return serializeGoalToolResult",
    to: "      executionContext: undefined,\n    })\n    const unavailable = inactiveGoalToolResult(\n      loadResult,\n      commandName,\n      isDisposed(),\n      commandRegistered,\n    )\n    if (unavailable) return serializeGoalToolResult",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "tool-only mode receives an actionable contention hint",
    file: "src/goal-plugin.js",
    from: "  const retryTarget = commandRegistered\n    ?",
    to: "  const retryTarget = true\n    ?",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive state remains isolated to its session",
    file: "src/goal-plugin.js",
    from: "    const passive = runtime.passiveSessions.get(sessionID)\n    pruneExpiredPendingCommandTurns(sessionID)\n    const commandTurnInFlight =",
    to: "    const passive = runtime.passiveSessions.values().next().value\n    pruneExpiredPendingCommandTurns(sessionID)\n    const commandTurnInFlight =",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "expired pending passive command guards do not block takeover forever",
    file: "src/goal-plugin.js",
    from: "    pruneExpiredPendingCommandTurns(sessionID)\n    const commandTurnInFlight =",
    to: "    if (false) pruneExpiredPendingCommandTurns(sessionID)\n    const commandTurnInFlight =",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "only a fresh command may retry past an accepted passive command guard",
    file: "src/goal-plugin.js",
    from: "        freshCommandBoundary: true,",
    to: "        freshCommandBoundary: false,",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive session tombstones are retained until explicit takeover",
    file: "src/goal-plugin.js",
    from: "    runtime.passiveSessions.set(sessionID, entry)\n    if (!previous?.warned) {",
    to: "    runtime.passiveSessions.set(sessionID, entry)\n    while (runtime.passiveSessions.size > 1000) runtime.passiveSessions.delete(runtime.passiveSessions.keys().next().value)\n    if (!previous?.warned) {",
    test: "test/passive-retention.test.js",
  },
  {
    name: "ambient hooks never acquire a formerly contended session",
    file: "src/goal-plugin.js",
    from: "      (!retryPassive || commandTurnInFlight || Date.now() < passive.retryAt)",
    to: "      (false || commandTurnInFlight || Date.now() < passive.retryAt)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "an active passive-command turn prevents lease takeover",
    file: "src/goal-plugin.js",
    from: "      (!retryPassive || commandTurnInFlight || Date.now() < passive.retryAt)",
    to: "      (!retryPassive || Date.now() < passive.retryAt)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive slash commands cannot mutate goal state",
    file: "src/goal-plugin.js",
    from: '      if (loadResult.kind === "passive") {',
    to: "      if (false) {",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive command replies retain their denial provenance",
    file: "src/goal-plugin.js",
    from: "        commandTurn.passive = true",
    to: "        commandTurn.passive = false",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive legacy goal tools cannot invoke handlers",
    file: "src/goal-plugin.js",
    from: "    if (unavailable) return unavailable.message",
    to: "    if (false) return unavailable.message",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive canonical goal tools return the ownership error",
    file: "src/goal-plugin.js",
    from: "    if (unavailable) return serializeGoalToolResult(operation, unavailable)",
    to: "    if (false) return serializeGoalToolResult(operation, unavailable)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "takeover preserves passive command security tombstones",
    file: "src/goal-plugin.js",
    from: "  if (!preserveCommandSecurity) {",
    to: "  if (true) {",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "late passive command replies stay excluded after takeover",
    file: "src/goal-plugin.js",
    from: "        if (controlCommandAssistant) {",
    to: "        if (false) {",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "goal tools register without an external helper",
    file: "src/goal-plugin.js",
    from: "    hooks.tool = buildAgentTools(\n      bundledToolHelper,\n      agentToolHandlers,\n      ensureSessionLoaded,\n      commandName,\n      () => runtime.disposed,\n      registerCommand,\n    )",
    to: "hooks.tool = {}",
    test: "test/goal-plugin.test.js",
  },
]

try {
  await mkdir(join(root, "node_modules"), { recursive: true })
  await Promise.all([
    cp(join(repository, "src"), join(root, "src"), { recursive: true }),
    cp(join(repository, "test"), join(root, "test"), { recursive: true }),
    cp(join(repository, "node_modules", "zod"), join(root, "node_modules", "zod"), {
      recursive: true,
    }),
    writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" })),
  ])

  const baselineTests = [...new Set(mutants.map(({ test }) => test))]
  for (const testFile of baselineTests) {
    const result = spawnSync(process.execPath, ["--test", testFile], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, `mutation baseline failed for ${testFile}\n${result.stdout}\n${result.stderr}`)
  }

  for (const mutant of mutants) {
    const path = join(root, mutant.file)
    const original = await readFile(path, "utf8")
    const { occurrences, mutate } = locateMutation(mutant, original)
    assert.equal(occurrences, 1, staleAnchorMessage(mutant, occurrences))
    const mutated = mutate()
    assert.notEqual(
      mutated,
      original,
      `${mutant.name}: anchor matched ${mutant.file} but the replacement left the source\n` +
        `unchanged, so nothing was actually mutated and the test below would pass for the\n` +
        `wrong reason. Check the 'to' replacement in scripts/mutation-contract.mjs.`,
    )
    await writeFile(path, mutated)

    const result = spawnSync(process.execPath, ["--test", mutant.test], { cwd: root, encoding: "utf8" })
    assert.notEqual(result.status, 0, `${mutant.name}: test suite survived the mutant`)
    await writeFile(path, original)
    console.log(`killed mutant: ${mutant.name}`)
  }

  console.log(`mutation contract passed (${mutants.length}/${mutants.length} critical mutants killed)`)
} finally {
  await rm(root, { recursive: true, force: true })
}
