import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("..", import.meta.url))
const root = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-mutations-"))

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
]

try {
  await Promise.all([
    cp(join(repository, "src"), join(root, "src"), { recursive: true }),
    cp(join(repository, "test"), join(root, "test"), { recursive: true }),
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
    const occurrences = original.split(mutant.from).length - 1
    assert.equal(occurrences, 1, `${mutant.name}: expected exactly one mutation target, found ${occurrences}`)
    await writeFile(path, original.replace(mutant.from, mutant.to))

    const result = spawnSync(process.execPath, ["--test", mutant.test], { cwd: root, encoding: "utf8" })
    assert.notEqual(result.status, 0, `${mutant.name}: test suite survived the mutant`)
    await writeFile(path, original)
    console.log(`killed mutant: ${mutant.name}`)
  }

  console.log(`mutation contract passed (${mutants.length}/${mutants.length} critical mutants killed)`)
} finally {
  await rm(root, { recursive: true, force: true })
}
