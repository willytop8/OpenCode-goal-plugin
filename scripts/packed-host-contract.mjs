import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const repository = new URL("..", import.meta.url)
const root = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-packed-host-"))
const packDirectory = join(root, "pack")
const projectDirectory = join(root, "host-project")
const cacheDirectory = join(root, "npm-cache")
const npmEnvironment = { ...process.env, npm_config_cache: cacheDirectory }

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
  ])
  await writeFile(
    join(projectDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  )

  const packResult = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory],
      { cwd: repository, encoding: "utf8", env: npmEnvironment },
    ),
  )
  assert.equal(packResult.length, 1)
  const tarball = join(packDirectory, packResult[0].filename)

  // Install only the artifact npm produced. The optional peer is omitted so this
  // contract test is offline-safe and cannot mutate the user's OpenCode install.
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--omit=peer",
      "--offline",
      "--cache",
      cacheDirectory,
      tarball,
    ],
    { cwd: projectDirectory, encoding: "utf8", env: npmEnvironment },
  )

  const installedManifestPath = join(
    projectDirectory,
    "node_modules",
    "opencode-goal-plugin",
    "package.json",
  )
  const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"))
  const installedEntry = join(
    projectDirectory,
    "node_modules",
    "opencode-goal-plugin",
    installedManifest.main,
  )
  const installed = await import(pathToFileURL(installedEntry).href)

  assert.equal(installed.default.id, "opencode-goal-plugin")
  assert.equal(installed.default.server, installed.GoalPlugin)

  const sessionID = "packed-host-contract"
  const promptCalls = []
  const client = {
    app: { log: async () => {} },
    session: {
      messages: async ({ path }) => ({
        data: [
          {
            info: {
              id: "assistant-packed-contract",
              role: "assistant",
              sessionID: path.id,
              tokens: { input: 1, output: 1, reasoning: 0 },
            },
            parts: [{ type: "text", text: "Work remains." }],
          },
        ],
      }),
      promptAsync: async (input) => {
        promptCalls.push(input)
        return {}
      },
    },
  }
  const hooks = await installed.GoalPlugin(
    { client, directory: projectDirectory },
    {
      persistState: false,
      registerTools: false,
      minDelayMs: 1,
      noToolCallTurnsBeforePause: 10,
    },
  )

  for (const hook of [
    "config",
    "command.execute.before",
    "event",
    "experimental.chat.system.transform",
    "experimental.session.compacting",
    "experimental.compaction.autocontinue",
    "dispose",
  ]) {
    assert.equal(typeof hooks[hook], "function", `${hook} must be callable`)
  }
  const config = {}
  await hooks.config(config)
  assert.equal(config.agent.goal.mode, "primary")
  assert.equal(config.agent["goal-verify"].tools.edit, false)

  const output = { parts: [] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: "verify the installed artifact --max-turns 1" },
    output,
  )
  assert.match(output.parts[0]?.text, /New active goal/)

  // Let the configured throttle window elapse before idle. This avoids leaving
  // the contract dependent on the host's event-loop/timer shutdown behavior.
  await new Promise((resolve) => setTimeout(resolve, 5))

  await hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID, status: { type: "idle" } },
    },
  })

  assert.equal(promptCalls.length, 1)
  // PluginInput currently supplies OpenCode's generated legacy client shape:
  // session.promptAsync({ path, body }). The standalone adapter suite covers
  // flattened v2 clients separately.
  assert.deepEqual(promptCalls[0].path, { id: sessionID })
  assert.equal(promptCalls[0].body.parts.length, 1)
  assert.deepEqual(promptCalls[0].body.parts[0].metadata, {
    "opencode-goal-plugin": { kind: "continuation" },
  })
  assert.equal(promptCalls[0].body.parts[0].synthetic, true)

  await hooks.dispose()
  await hooks.dispose()

  console.log(
    `packed host contract passed (${installedManifest.name}@${installedManifest.version}; ${packResult[0].size} byte tarball)`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
