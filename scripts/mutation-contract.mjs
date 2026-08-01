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
    from: 'new Set([\"messages\", \"get\"])',
    to: 'new Set([\"messages\", \"get\", \"prompt\"])',
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
    from: "if (durable === false) {\n          restoreAfterTerminalPersistenceFailure(sessionID, goal, { ordered })",
    to: "if (false) {\n          restoreAfterTerminalPersistenceFailure(sessionID, goal, { ordered })",
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
    from: '          parentOwner?.policy === "control" &&\n',
    to: "          false &&\n",
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
    name: "goal tools register without an external helper",
    file: "src/goal-plugin.js",
    from: "hooks.tool = buildAgentTools(bundledToolHelper, agentToolHandlers, ensureSessionLoaded)",
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
    const from = matchCheckoutNewlines(mutant.from, original)
    const to = matchCheckoutNewlines(mutant.to, original)
    const occurrences = original.split(from).length - 1
    assert.equal(occurrences, 1, `${mutant.name}: expected exactly one mutation target, found ${occurrences}`)
    await writeFile(path, original.replace(from, to))

    const result = spawnSync(process.execPath, ["--test", mutant.test], { cwd: root, encoding: "utf8" })
    assert.notEqual(result.status, 0, `${mutant.name}: test suite survived the mutant`)
    await writeFile(path, original)
    console.log(`killed mutant: ${mutant.name}`)
  }

  console.log(`mutation contract passed (${mutants.length}/${mutants.length} critical mutants killed)`)
} finally {
  await rm(root, { recursive: true, force: true })
}
