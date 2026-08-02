import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
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

function execNpm(args, options) {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options)
  }
  if (process.platform === "win32") {
    return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], options)
  }
  return execFileSync("npm", args, options)
}

const expectedTools = [
  "clear_goal",
  "get_goal",
  "get_goal_history",
  "goal_block",
  "goal_complete",
  "goal_pause",
  "goal_resume",
  "goal_set",
  "goal_status",
  "set_goal",
  "update_goal",
]

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
    execNpm(
      ["pack", "--json", "--pack-destination", packDirectory],
      { cwd: repository, encoding: "utf8", env: npmEnvironment },
    ),
  )
  assert.equal(packResult.length, 1)
  const tarball = join(packDirectory, packResult[0].filename)

  // Install only the artifact npm produced. A fresh cache forces npm to resolve
  // every runtime dependency declared by that artifact instead of borrowing the
  // repository's development dependency tree.
  execNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
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
  const commandMessageID = "command-packed-contract"
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
              parentID: commandMessageID,
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
      minDelayMs: 1,
      noToolCallTurnsBeforePause: 10,
    },
  )

  for (const hook of [
    "config",
    "chat.params",
    "chat.message",
    "command.execute.before",
    "tool.execute.before",
    "event",
    "experimental.chat.system.transform",
    "experimental.session.compacting",
    "experimental.compaction.autocontinue",
    "dispose",
  ]) {
    assert.equal(typeof hooks[hook], "function", `${hook} must be callable`)
  }
  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), expectedTools)
  for (const name of expectedTools) {
    assert.equal(typeof hooks.tool[name].execute, "function", `${name} must be executable`)
  }
  const config = {}
  await hooks.config(config)
  assert.equal(config.agent.goal.mode, "primary")
  assert.equal(config.agent["goal-verify"].tools.edit, false)

  const hostParts = [{ type: "text", text: "verify the installed artifact --max-turns 1" }]
  const output = {
    message: { id: commandMessageID, role: "user", sessionID },
    parts: hostParts,
  }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: "verify the installed artifact --max-turns 1" },
    output,
  )
  assert.strictEqual(output.parts, hostParts)
  assert.match(hostParts[0]?.text, /New active goal/)
  assert.equal(hostParts[0]?.synthetic, true)
  assert.equal(hostParts[0]?.metadata?.["opencode-goal-plugin"]?.kind, "command")
  assert.match(hostParts[0]?.metadata?.["opencode-goal-plugin"]?.id, /^[0-9a-f-]{36}$/)
  output.parts = hostParts.map((part, index) => ({
    ...part,
    id: `part-packed-contract-${index}`,
    messageID: commandMessageID,
    sessionID,
  }))
  await hooks["chat.message"](
    {
      sessionID,
      messageID: commandMessageID,
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    output,
  )

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
  assert.equal(
    promptCalls[0].body.parts[0].metadata?.["opencode-goal-plugin"]?.kind,
    "continuation",
  )
  assert.match(
    promptCalls[0].body.parts[0].metadata?.["opencode-goal-plugin"]?.id,
    /^[0-9a-f-]{36}$/,
  )
  assert.equal(promptCalls[0].body.parts[0].synthetic, true)

  await hooks.dispose()
  await hooks.dispose()

  // Prove the installed artifact keeps same-session contention graceful while
  // retaining one durable writer and requiring an explicit takeover.
  const persistentSessionID = "packed-host-passive-session"
  const stateFilePath = join(projectDirectory, "packed-state.json")
  const sessionKey = createHash("sha256").update(persistentSessionID).digest("hex")
  const shardStatePath = join(`${stateFilePath}.sessions`, sessionKey, "state.json")
  const shardLedgerPath = `${shardStatePath}.ledger.jsonl`
  const passivePromptCalls = []
  let persistentMessages = []
  const persistentClient = {
    app: { log: async () => {} },
    session: {
      messages: async () => ({ data: persistentMessages }),
      promptAsync: async (input) => {
        passivePromptCalls.push(input)
        return {}
      },
    },
  }
  const owner = await installed.GoalPlugin(
    { client: persistentClient, directory: projectDirectory },
    { stateFilePath, minDelayMs: 1, noToolCallTurnsBeforePause: 10 },
  )
  const contender = await installed.GoalPlugin(
    { client: persistentClient, directory: projectDirectory },
    { stateFilePath, minDelayMs: 1, noToolCallTurnsBeforePause: 10 },
  )
  try {
    await owner["command.execute.before"](
      {
        command: "goal",
        sessionID: persistentSessionID,
        arguments: "persisted installed-artifact objective",
      },
      { parts: [] },
    )
    const stateBefore = await readFile(shardStatePath, "utf8")
    const ledgerBefore = await readFile(shardLedgerPath, "utf8")

    await contender["chat.params"]({ sessionID: persistentSessionID, agent: "build" })
    const passiveMessageID = "packed-passive-command"
    const passiveOutput = {
      message: { id: passiveMessageID, role: "user", sessionID: persistentSessionID },
      parts: [],
    }
    await contender["command.execute.before"](
      { command: "goal", sessionID: persistentSessionID, arguments: "status" },
      passiveOutput,
    )
    assert.match(passiveOutput.parts[0].text, /Goal controls are unavailable/)
    Object.assign(passiveOutput.parts[0], {
      id: "packed-passive-command-part",
      messageID: passiveMessageID,
      sessionID: persistentSessionID,
    })
    await contender["chat.message"](
      { sessionID: persistentSessionID, messageID: passiveMessageID, agent: "build" },
      passiveOutput,
    )
    const passiveAssistant = {
      info: {
        id: "packed-passive-command-assistant",
        parentID: passiveMessageID,
        role: "assistant",
        sessionID: persistentSessionID,
      },
      parts: [{ type: "text", text: "Ownership denial reported." }],
    }
    persistentMessages = [passiveAssistant]
    await contender.event({
      event: {
        type: "message.updated",
        properties: { info: passiveAssistant.info },
      },
    })
    await contender.event({
      event: {
        type: "session.status",
        properties: { sessionID: persistentSessionID, status: { type: "idle" } },
      },
    })
    const passiveStatus = JSON.parse(
      await contender.tool.goal_status.execute({}, { sessionID: persistentSessionID }),
    )
    assert.equal(passiveStatus.ok, false)
    assert.equal(passiveStatus.error, "session_owned_elsewhere")
    assert.equal(await readFile(shardStatePath, "utf8"), stateBefore)
    assert.equal(await readFile(shardLedgerPath, "utf8"), ledgerBefore)
    assert.equal(passivePromptCalls.length, 0)

    await owner.dispose()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const takeover = JSON.parse(
      await contender.tool.goal_status.execute({}, { sessionID: persistentSessionID }),
    )
    assert.equal(takeover.ok, true)
    assert.match(takeover.message, /persisted installed-artifact objective/)
    assert.match(takeover.message, /recovered after restart|paused|stopped/i)
    await contender.event({
      event: {
        type: "session.status",
        properties: { sessionID: persistentSessionID, status: { type: "idle" } },
      },
    })
    assert.equal(passivePromptCalls.length, 0)
  } finally {
    await owner.dispose()
    await contender.dispose()
  }

  console.log(
    `packed host contract passed (${installedManifest.name}@${installedManifest.version}; ${packResult[0].size} byte tarball)`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
